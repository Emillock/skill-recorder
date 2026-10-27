import assert from "node:assert/strict";
import test from "node:test";

import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { AWS_PROXY_NOT_CONFIGURED_ERROR, AWS_PROXY_TOKEN_REJECTED_ERROR } from "../../common/ipc";
import type { AiConfig } from "./config";
import { ProxyApi } from "./proxy-api";
import { ProxyRuntime, ProxySession, type MessagesApi } from "./proxy-runtime";
import type { AgentTool } from "./types";

function message(content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  } as unknown as BetaMessage;
}

const toolUse = (id: string, name: string, input: unknown): BetaContentBlock =>
  ({ type: "tool_use", id, name, input }) as BetaContentBlock;

type Reply = BetaMessage | ((signal: AbortSignal) => Promise<BetaMessage>);

function fakeMessages(replies: Reply[]) {
  const requests: BetaMessageStreamParams[] = [];
  const api: MessagesApi = {
    stream(params, { signal }) {
      requests.push(structuredClone(params));
      const reply = replies.shift();
      return {
        finalMessage: async () => {
          if (!reply) throw new Error("no more replies");
          return typeof reply === "function" ? reply(signal) : reply;
        },
      };
    },
  };
  return { api, requests };
}

function waitForAbort(signal: AbortSignal): Promise<BetaMessage> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
  });
}

function session(
  replies: Reply[],
  tools: AgentTool[],
  options: { timeoutMs?: number; uploads?: string[] } = {},
) {
  const { api, requests } = fakeMessages(replies);
  const uploads = options.uploads ?? [];
  const s = new ProxySession(
    { systemMessage: "You analyze recordings.", tools, workingDirectory: "/tmp" },
    {
      messages: api,
      uploadImage: async (data, mimeType) => {
        uploads.push(`${mimeType}:${data}`);
        return `srimg_${uploads.length}`;
      },
      model: "claude-opus-5-5",
      effort: "high",
      defaultTimeoutMs: options.timeoutMs ?? 5_000,
    },
  );
  return { session: s, requests, uploads };
}

const echoTool = (calls: unknown[]): AgentTool => ({
  name: "get_timeline",
  description: "Read the timeline.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  handler: (args) => {
    calls.push(args);
    return "timeline text";
  },
});

test("runs tools locally and sends every result back until the model ends its turn", async () => {
  const calls: unknown[] = [];
  const { session: s, requests } = session(
    [
      message([{ type: "text", text: "Looking." }, toolUse("t1", "get_timeline", { from: 1 })], "tool_use"),
      message([{ type: "text", text: "Done." }], "end_turn"),
    ],
    [echoTool(calls)],
  );
  await s.sendAndWait("Analyze this.");
  assert.deepEqual(calls, [{ from: 1 }]);
  assert.equal(requests.length, 2);
  const first = requests[0];
  assert.equal(first.model, "claude-opus-5-5");
  assert.deepEqual(first.output_config, { effort: "high" });
  assert.deepEqual(first.cache_control, { type: "ephemeral" });
  assert.deepEqual(first.system, [
    { type: "text", text: "You analyze recordings.", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(first.tools, [
    {
      name: "get_timeline",
      description: "Read the timeline.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ]);
  assert.equal("thinking" in first, false);
  const second = requests[1].messages;
  assert.equal(second.length, 3);
  assert.deepEqual(second[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "timeline text" }],
  });
});

test("uploads frame images once and references them by file id", async () => {
  const frames: AgentTool = {
    name: "get_frames",
    description: "View frames.",
    parameters: { type: "object" },
    handler: () => ({
      textResultForLlm: "2 frames",
      resultType: "success",
      binaryResultsForLlm: [
        { type: "image", mimeType: "image/jpeg", data: "AAAA", description: "1.0s" },
        { type: "image", mimeType: "image/jpeg", data: "BBBB" },
      ],
    }),
  };
  const { session: s, requests, uploads } = session(
    [
      message([toolUse("t1", "get_frames", {})], "tool_use"),
      message([{ type: "text", text: "ok" }], "end_turn"),
    ],
    [frames],
  );
  await s.sendAndWait("Look.");
  assert.deepEqual(uploads, ["image/jpeg:AAAA", "image/jpeg:BBBB"]);
  assert.deepEqual(requests[1].messages[2], {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "2 frames" },
          { type: "text", text: "1.0s" },
          { type: "image", source: { type: "file", file_id: "srimg_1" } },
          { type: "image", source: { type: "file", file_id: "srimg_2" } },
        ],
      },
    ],
  });
});

test("unknown tools, thrown handlers, and failure results come back as tool errors", async () => {
  const failing: AgentTool = {
    name: "submit_analysis",
    description: "Submit.",
    parameters: { type: "object" },
    handler: () => ({ textResultForLlm: "Invalid steps.", resultType: "failure" }),
  };
  const throwing: AgentTool = {
    name: "get_events",
    description: "Events.",
    parameters: { type: "object" },
    handler: () => {
      throw new Error("disk unreadable");
    },
  };
  const { session: s, requests } = session(
    [
      message(
        [toolUse("a", "nope", {}), toolUse("b", "get_events", {}), toolUse("c", "submit_analysis", {})],
        "tool_use",
      ),
      message([{ type: "text", text: "ok" }], "end_turn"),
    ],
    [failing, throwing],
  );
  await s.sendAndWait("Go.");
  assert.deepEqual(requests[1].messages[2].content, [
    { type: "tool_result", tool_use_id: "a", content: 'Unknown tool "nope".', is_error: true },
    { type: "tool_result", tool_use_id: "b", content: "The tool failed: disk unreadable", is_error: true },
    {
      type: "tool_result",
      tool_use_id: "c",
      content: [{ type: "text", text: "Invalid steps." }],
      is_error: true,
    },
  ]);
});

test("a timed-out turn is rolled back so the next turn continues the earlier conversation", async () => {
  const { session: s, requests } = session(
    [
      message([{ type: "text", text: "first" }], "end_turn"),
      (signal) => waitForAbort(signal),
      message([{ type: "text", text: "third" }], "end_turn"),
    ],
    [],
    { timeoutMs: 50 },
  );
  await s.sendAndWait("one");
  await assert.rejects(s.sendAndWait("two"), /did not finish within/);
  await s.sendAndWait("three");
  const history = requests[2].messages;
  assert.deepEqual(
    history.map((m) => [m.role, typeof m.content === "string" ? m.content : "blocks"]),
    [["user", "one"], ["assistant", "blocks"], ["user", "three"]],
  );
});

test("abort cancels the in-flight turn", async () => {
  const { session: s } = session([(signal) => waitForAbort(signal)], []);
  const turn = s.sendAndWait("go");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await s.abort();
  await assert.rejects(turn, /^Error: Canceled\.$/);
});

test("refusals and truncated replies fail the turn with a readable message", async () => {
  const refused = session(
    [message([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })],
    [],
  );
  await assert.rejects(refused.session.sendAndWait("go"), /declined this request \(cyber\)/);
  const truncated = session([message([{ type: "text", text: "partial" }], "max_tokens")], []);
  await assert.rejects(truncated.session.sendAndWait("go"), /cut off/);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const config = (overrides: Partial<AiConfig> = {}): AiConfig => ({
  provider: "aws",
  proxyUrl: "https://proxy.example",
  proxyToken: "srp_test_token",
  model: "",
  ...overrides,
});

test("the AWS runtime requires a configured service and a token it accepts", async () => {
  await assert.rejects(
    new ProxyRuntime("Test", config({ proxyToken: "" })).start(),
    (err: Error) => err.message === AWS_PROXY_NOT_CONFIGURED_ERROR,
  );
  const rejected = new ProxyRuntime("Test", config(), {
    fetch: async () => jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "bad" } }),
  });
  await assert.rejects(rejected.start(), (err: Error) => err.message === AWS_PROXY_TOKEN_REJECTED_ERROR);
  const disallowed = new ProxyRuntime("Test", config({ model: "claude-haiku-5-5" }), {
    fetch: async () =>
      jsonResponse(200, { ok: true, user: "ana", defaultModel: "claude-opus-5-5", allowedModels: ["claude-opus-5-5"] }),
  });
  await assert.rejects(disallowed.start(), /doesn't allow the model "claude-haiku-5-5"/);
});

test("a started AWS runtime reports the proxy user and creates sessions", async () => {
  const seen: string[] = [];
  const runtime = new ProxyRuntime("Test", config(), {
    fetch: async (input, init) => {
      seen.push(`${init?.method} ${String(input)} ${new Headers(init?.headers).get("authorization")}`);
      return jsonResponse(200, { ok: true, user: "ana", defaultModel: "claude-opus-5-5", allowedModels: [] });
    },
    createMessages: () => fakeMessages([message([{ type: "text", text: "hi" }], "end_turn")]).api,
  });
  assert.deepEqual(await runtime.start(), { account: "ana", model: "claude-opus-5-5" });
  assert.deepEqual(seen, ["GET https://proxy.example/v1/health Bearer srp_test_token"]);
  const s = await runtime.createSession({ systemMessage: "x", tools: [], workingDirectory: "/tmp" });
  await s.sendAndWait("hello");
});

test("the proxy API uploads identical images once and parses transcripts", async () => {
  let uploads = 0;
  const api = new ProxyApi("https://proxy.example", "tok", async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/uploads/images")) {
      uploads++;
      return jsonResponse(200, { id: `srimg_${uploads}` });
    }
    return jsonResponse(200, {
      text: " hello there",
      chunks: [{ timestamp: [0, 1.5], text: " hello" }, { timestamp: [1.5, null], text: " there" }, { bad: true }],
    });
  });
  assert.equal(await api.uploadImage("QUJD", "image/jpeg"), "srimg_1");
  assert.equal(await api.uploadImage("QUJD", "image/jpeg"), "srimg_1");
  assert.equal(uploads, 1);
  assert.deepEqual(await api.transcribe(new Uint8Array([1, 2]), "en"), {
    text: " hello there",
    chunks: [
      { timestamp: [0, 1.5], text: " hello" },
      { timestamp: [1.5, null], text: " there" },
    ],
  });
});
