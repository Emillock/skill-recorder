import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { handleRequest, type Deps } from "../src/app.ts";
import { CachedTokenStore, hashToken, type TokenRecord, type TokenStore } from "../src/auth.ts";
import { loadConfig, type ProxyConfig } from "../src/config.ts";
import type { BufferedResponse, ProxyRequest, ProxyResponse, StreamingResponse } from "../src/http.ts";
import { CachedImageStore, imageKey, type ImageStore, type StoredImage } from "../src/images.ts";
import { toProxyRequest } from "../src/lambda-event.ts";
import type { ModelGateway, StreamEvent } from "../src/messages.ts";
import { normalizeTranscript, type SpeechEndpoint } from "../src/transcribe.ts";

const TOKEN = `srp_${"a".repeat(43)}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(40)]);

const config: ProxyConfig = {
  tokensTable: "tokens",
  imagesBucket: "images",
  bedrockRegion: "us-east-1",
  allowedModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
  defaultModel: "claude-opus-5-5",
  fallbackModel: "claude-opus-4-8",
  maxOutputTokens: 64_000,
  asrEndpointName: "whisper-endpoint",
  asrRequestFormat: "json",
};

class MemoryImages implements ImageStore {
  readonly items = new Map<string, StoredImage>();
  async put(key: string, image: StoredImage) {
    this.items.set(key, image);
  }
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
}

function fixture(overrides: Partial<Deps> = {}) {
  const calls: { stream: Record<string, unknown>[]; create: Record<string, unknown>[]; speech: unknown[] } = {
    stream: [],
    create: [],
    speech: [],
  };
  const logs: Record<string, unknown>[] = [];
  const tokens: TokenStore = {
    find: async (hash) => (hash === hashToken(TOKEN) ? { user: "ana@example.com" } : null),
  };
  const images = new MemoryImages();
  const models: ModelGateway = {
    stream: async (params) => {
      calls.stream.push(structuredClone(params));
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 4 } } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } };
        yield { type: "message_stop" };
      })();
    },
    create: async (params) => {
      calls.create.push(structuredClone(params));
      return { id: "msg_1", type: "message", content: [], usage: { input_tokens: 5, output_tokens: 1 } };
    },
  };
  const speech: SpeechEndpoint = {
    invoke: async (input) => {
      calls.speech.push(input);
      return Buffer.from(JSON.stringify({ text: " hi", chunks: [{ timestamp: [0, 1.2], text: " hi" }] }));
    },
  };
  const deps: Deps = { config, tokens, images, models, speech, log: (e) => logs.push(e), ...overrides };
  return { deps, calls, logs, images };
}

function request(method: string, path: string, init: { body?: Buffer | string; headers?: Record<string, string>; query?: string } = {}): ProxyRequest {
  return {
    method,
    path,
    query: new URLSearchParams(init.query ?? ""),
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
    body: Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body ?? ""),
  };
}

function body(response: ProxyResponse): any {
  assert.ok("body" in response);
  return JSON.parse((response as BufferedResponse).body.toString());
}

async function readStream(response: ProxyResponse): Promise<string> {
  assert.ok("stream" in response);
  let text = "";
  for await (const chunk of (response as StreamingResponse).stream) text += chunk;
  return text;
}

test("every route requires a known, enabled token", async () => {
  const { deps } = fixture();
  const missing = await handleRequest({ ...request("GET", "/v1/health"), headers: {} }, deps);
  assert.equal(missing.status, 401);
  assert.equal(body(missing).error.type, "authentication_error");
  const unknown = await handleRequest(
    { ...request("GET", "/v1/health"), headers: { "x-api-key": `srp_${"b".repeat(43)}` } },
    deps,
  );
  assert.equal(unknown.status, 401);
  const disabled = fixture({ tokens: { find: async () => ({ user: "ex", disabled: true }) } });
  assert.equal((await handleRequest(request("GET", "/v1/health"), disabled.deps)).status, 401);
});

test("health reports the user, models, and whether speech-to-text is set up", async () => {
  const { deps } = fixture();
  const response = await handleRequest(request("GET", "/v1/health"), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(body(response), {
    ok: true,
    user: "ana@example.com",
    defaultModel: "claude-opus-5-5",
    allowedModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
    transcription: true,
  });
  assert.equal(body(await handleRequest(request("GET", "/v1/health"), fixture({ speech: null }).deps)).transcription, false);
  assert.equal((await handleRequest(request("GET", "/v1/nope"), deps)).status, 404);
});

test("messages map the model to Bedrock, clamp max_tokens, drop unsupported fields, and stream SSE", async () => {
  const { deps, calls, logs } = fixture();
  const response = await handleRequest(
    request("POST", "/v1/messages", {
      query: "beta=true",
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 500_000,
        stream: true,
        fallbacks: "default",
        speed: "fast",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  const text = await readStream(response);
  assert.match(text, /^event: message_start\ndata: \{"type":"message_start"/);
  assert.match(text, /event: message_stop\ndata: \{"type":"message_stop"\}\n\n$/);
  assert.deepEqual(calls.stream[0], {
    model: "anthropic.claude-opus-5-5",
    max_tokens: 64_000,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.deepEqual(logs.at(-1), {
    route: "messages",
    user: "ana@example.com",
    model: "claude-opus-5-5",
    stream: true,
    images: 0,
    outcome: "ok",
    input_tokens: 10,
    cache_read_input_tokens: 4,
    output_tokens: 3,
  });
});

test("non-streaming messages return the message JSON", async () => {
  const { deps, calls } = fixture();
  const response = await handleRequest(
    request("POST", "/v1/messages", {
      body: JSON.stringify({ model: "anthropic.claude-sonnet-5-5", max_tokens: 100, messages: [] }),
    }),
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal(body(response).id, "msg_1");
  assert.equal(calls.create[0].model, "anthropic.claude-sonnet-5-5");
  assert.equal(calls.create[0].max_tokens, 100);
});

test("disallowed models and malformed bodies are rejected before Bedrock", async () => {
  const { deps, calls } = fixture();
  const badModel = await handleRequest(
    request("POST", "/v1/messages", { body: JSON.stringify({ model: "claude-fable-5-1", messages: [] }) }),
    deps,
  );
  assert.equal(badModel.status, 400);
  assert.match(body(badModel).error.message, /isn't allowed/);
  assert.equal((await handleRequest(request("POST", "/v1/messages", { body: "{nope" }), deps)).status, 400);
  assert.equal(calls.stream.length + calls.create.length, 0);
});

test("uploaded images are stored per user and inlined into messages, including tool results", async () => {
  const { deps, calls, images } = fixture();
  const upload = await handleRequest(
    request("POST", "/v1/uploads/images", { body: JPEG, headers: { "content-type": "image/jpeg" } }),
    deps,
  );
  assert.equal(upload.status, 200);
  const { id } = body(upload);
  const digest = createHash("sha256").update(JPEG).digest("hex");
  assert.equal(id, `srimg_${digest}`);
  assert.ok(images.items.has(imageKey("ana@example.com", digest)));

  const ref = { type: "image", source: { type: "file", file_id: id } };
  await handleRequest(
    request("POST", "/v1/messages", {
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 10,
        messages: [
          { role: "user", content: [ref] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "x" }, ref] }] },
        ],
      }),
    }),
    deps,
  );
  const inlined = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } };
  const sent = calls.create[0].messages as any[];
  assert.deepEqual(sent[0].content, [inlined]);
  assert.deepEqual(sent[1].content[0].content[1], inlined);
});

test("image references must be this user's unexpired uploads", async () => {
  const { deps } = fixture();
  const missing = await handleRequest(
    request("POST", "/v1/messages", {
      body: JSON.stringify({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: `srimg_${"c".repeat(64)}` } }] }],
      }),
    }),
    deps,
  );
  assert.equal(missing.status, 400);
  assert.match(body(missing).error.message, /isn't available anymore/);
  const foreign = await handleRequest(
    request("POST", "/v1/messages", {
      body: JSON.stringify({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file_abc" } }] }],
      }),
    }),
    deps,
  );
  assert.equal(foreign.status, 400);
});

test("uploads reject non-images and mismatched content types", async () => {
  const { deps } = fixture();
  const text = await handleRequest(
    request("POST", "/v1/uploads/images", { body: "hello", headers: { "content-type": "text/plain" } }),
    deps,
  );
  assert.equal(text.status, 400);
  const lying = await handleRequest(
    request("POST", "/v1/uploads/images", { body: JPEG, headers: { "content-type": "image/png" } }),
    deps,
  );
  assert.equal(lying.status, 400);
});

test("Bedrock errors keep their status and the API's error shape", async () => {
  const upstream = Object.assign(new Error("429 throttled"), {
    status: 429,
    error: { type: "error", error: { type: "rate_limit_error", message: "Too many tokens" } },
  });
  const { deps } = fixture({
    models: { stream: async () => Promise.reject(upstream), create: async () => Promise.reject(upstream) },
  });
  const response = await handleRequest(
    request("POST", "/v1/messages", { body: JSON.stringify({ model: "claude-opus-5-5", messages: [], stream: true }) }),
    deps,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(body(response), {
    type: "error",
    error: { type: "rate_limit_error", message: "Bedrock: Too many tokens" },
  });
});

test("an error after streaming starts is sent as an SSE error event", async () => {
  const { deps } = fixture({
    models: {
      create: async () => ({}),
      stream: async () =>
        (async function* (): AsyncIterable<StreamEvent> {
          yield { type: "message_start", message: {} };
          throw Object.assign(new Error("boom"), { status: 529 });
        })(),
    },
  });
  const response = await handleRequest(
    request("POST", "/v1/messages", { body: JSON.stringify({ model: "claude-opus-5-5", messages: [], stream: true }) }),
    deps,
  );
  const text = await readStream(response);
  assert.match(text, /event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error","message":"boom"\}\}\n\n$/);
});

test("transcribe sends JSON or raw WAV to SageMaker and returns timestamped chunks", async () => {
  const json = fixture();
  const response = await handleRequest(
    request("POST", "/v1/transcribe", { body: WAV, query: "language=de", headers: { "content-type": "audio/wav" } }),
    json.deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(body(response), { text: " hi", chunks: [{ timestamp: [0, 1.2], text: " hi" }] });
  const sent = json.calls.speech[0] as { body: Buffer; contentType: string };
  assert.equal(sent.contentType, "application/json");
  assert.deepEqual(JSON.parse(sent.body.toString()), { audio: WAV.toString("base64"), language: "de", return_timestamps: true });

  const wav = fixture({ config: { ...config, asrRequestFormat: "wav" } });
  await handleRequest(
    request("POST", "/v1/transcribe", { body: WAV, query: "language=en", headers: { "content-type": "audio/wav" } }),
    wav.deps,
  );
  assert.deepEqual(wav.calls.speech[0], { body: WAV, contentType: "audio/wav", customAttributes: "language=en" });
});

test("transcribe validates input and reports a missing endpoint", async () => {
  const { deps } = fixture();
  const bad = (query: string, contentType: string, data: Buffer) =>
    handleRequest(request("POST", "/v1/transcribe", { body: data, query, headers: { "content-type": contentType } }), deps);
  assert.equal((await bad("language=EN!", "audio/wav", WAV)).status, 400);
  assert.equal((await bad("language=en", "audio/mpeg", WAV)).status, 400);
  assert.equal((await bad("language=en", "audio/wav", Buffer.from("not a wav file at all"))).status, 400);
  const off = await handleRequest(
    request("POST", "/v1/transcribe", { body: WAV, headers: { "content-type": "audio/wav" } }),
    fixture({ speech: null }).deps,
  );
  assert.equal(off.status, 501);
});

test("transcripts are normalized from the common Whisper response shapes", () => {
  assert.deepEqual(normalizeTranscript({ text: "a", segments: [{ start: 1, end: 2, text: "a" }] }), {
    text: "a",
    chunks: [{ timestamp: [1, 2], text: "a" }],
  });
  assert.deepEqual(normalizeTranscript([{ text: "b", chunks: [{ timestamp: [0, null], text: "b" }] }]), {
    text: "b",
    chunks: [{ timestamp: [0, null], text: "b" }],
  });
  assert.deepEqual(normalizeTranscript("plain"), { text: "plain", chunks: [] });
  assert.throws(() => normalizeTranscript(42), /unexpected response/);
});

test("token lookups are cached briefly, including misses", async () => {
  let lookups = 0;
  let now = 0;
  const store = new CachedTokenStore(
    { find: async (): Promise<TokenRecord | null> => (lookups++, { user: "u" }) },
    1_000,
    () => now,
  );
  await store.find("h");
  await store.find("h");
  assert.equal(lookups, 1);
  now = 2_000;
  await store.find("h");
  assert.equal(lookups, 2);
});

test("the image cache evicts least recently used frames over its byte budget", async () => {
  const inner = new MemoryImages();
  let reads = 0;
  const counting: ImageStore = { put: (k, v) => inner.put(k, v), get: (k) => (reads++, inner.get(k)) };
  const cache = new CachedImageStore(counting, 10);
  await cache.put("a", { data: Buffer.alloc(6), contentType: "image/jpeg" });
  await cache.put("b", { data: Buffer.alloc(6), contentType: "image/jpeg" });
  await cache.get("b");
  assert.equal(reads, 0);
  await cache.get("a");
  assert.equal(reads, 1);
});

test("configuration requires the table, bucket, and at least one model", () => {
  assert.throws(() => loadConfig({ IMAGES_BUCKET: "b", AWS_REGION: "r", ALLOWED_MODELS: "claude-opus-5-5" }), /TOKENS_TABLE/);
  assert.throws(() => loadConfig({ TOKENS_TABLE: "t", IMAGES_BUCKET: "b", AWS_REGION: "r", ALLOWED_MODELS: " " }), /ALLOWED_MODELS/);
  const loaded = loadConfig({
    TOKENS_TABLE: "t",
    IMAGES_BUCKET: "b",
    AWS_REGION: "eu-west-1",
    ALLOWED_MODELS: "anthropic.claude-sonnet-5-5, claude-opus-5-5",
    FALLBACK_MODEL: "",
  });
  assert.deepEqual(loaded.allowedModels, ["claude-sonnet-5-5", "claude-opus-5-5"]);
  assert.equal(loaded.defaultModel, "claude-sonnet-5-5");
  assert.equal(loaded.fallbackModel, "");
  assert.equal(loaded.bedrockRegion, "eu-west-1");
  assert.equal(loaded.maxOutputTokens, 64_000);
});

test("function URL events become proxy requests", () => {
  const req = toProxyRequest({
    rawPath: "/v1/transcribe",
    rawQueryString: "language=fr",
    headers: { "Content-Type": "audio/wav", Authorization: "Bearer x" },
    body: WAV.toString("base64"),
    isBase64Encoded: true,
    requestContext: { http: { method: "POST" } },
  });
  assert.equal(req.method, "POST");
  assert.equal(req.query.get("language"), "fr");
  assert.equal(req.headers["content-type"], "audio/wav");
  assert.deepEqual(req.body, WAV);
});
