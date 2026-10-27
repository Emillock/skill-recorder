import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import Anthropic from "@anthropic-ai/sdk";

import { handleRequest, type Deps } from "../src/app.ts";
import { hashToken } from "../src/auth.ts";
import type { ProxyRequest } from "../src/http.ts";
import type { StoredImage } from "../src/images.ts";
import type { StreamEvent } from "../src/messages.ts";

const TOKEN = `srp_${"w".repeat(43)}`;

/** Serve handleRequest over real HTTP, the way the function URL does. */
async function serve(deps: Deps) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
    const request: ProxyRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: Buffer.concat(chunks),
    };
    const response = await handleRequest(request, deps);
    res.writeHead(response.status, response.headers);
    if ("stream" in response) {
      for await (const text of response.stream) res.write(text);
      res.end();
    } else {
      res.end(response.body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the official Anthropic SDK streams through the proxy, with uploaded frames inlined", async (t) => {
  const images = new Map<string, StoredImage>();
  const sent: Record<string, unknown>[] = [];
  const deps: Deps = {
    config: {
      tokensTable: "t",
      imagesBucket: "b",
      bedrockRegion: "us-east-1",
      allowedModels: ["claude-opus-5-5"],
      defaultModel: "claude-opus-5-5",
      fallbackModel: "",
      maxOutputTokens: 64_000,
      asrEndpointName: "",
      asrRequestFormat: "json",
    },
    tokens: { find: async (hash) => (hash === hashToken(TOKEN) ? { user: "ana" } : null) },
    images: { put: async (key, image) => void images.set(key, image), get: async (key) => images.get(key) ?? null },
    speech: null,
    log: () => undefined,
    models: {
      create: async () => ({}),
      stream: async (params) => {
        sent.push(params);
        return (async function* (): AsyncIterable<StreamEvent> {
          yield {
            type: "message_start",
            message: {
              id: "msg_1", type: "message", role: "assistant", model: params.model, content: [],
              stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 },
            },
          };
          yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_frames", input: {} } };
          yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"fromMs":0,' } };
          yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"toMs":1000}' } };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } };
          yield { type: "message_stop" };
        })();
      },
    },
  };
  const { server, baseURL } = await serve(deps);
  t.after(() => server.close());

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7]);
  const upload = await fetch(`${baseURL}/v1/uploads/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/jpeg" },
    body: jpeg,
  });
  const { id } = (await upload.json()) as { id: string };

  const client = new Anthropic({ baseURL, apiKey: TOKEN, maxRetries: 0 });
  const message = await client.beta.messages
    .stream({
      model: "claude-opus-5-5",
      max_tokens: 1_000,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: id } }] }],
    })
    .finalMessage();

  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content, [{ type: "tool_use", id: "toolu_1", name: "get_frames", input: { fromMs: 0, toMs: 1000 } }]);
  assert.equal(sent[0].model, "anthropic.claude-opus-5-5");
  assert.deepEqual((sent[0].messages as any[])[0].content[0].source, {
    type: "base64",
    media_type: "image/jpeg",
    data: jpeg.toString("base64"),
  });

  await assert.rejects(
    new Anthropic({ baseURL, apiKey: `srp_${"x".repeat(43)}`, maxRetries: 0 }).beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
    Anthropic.AuthenticationError,
  );
});
