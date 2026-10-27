import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type {
  BetaMessageStreamParams,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ProxyConfig } from "./config.ts";
import {
  errorMessage,
  errorTypeFor,
  HttpError,
  isObject,
  json,
  parseJsonBody,
  type ErrorType,
  type ProxyRequest,
  type ProxyResponse,
} from "./http.ts";
import { inlineImages, type ImageStore } from "./images.ts";

/**
 * `POST /v1/messages`: the Anthropic Messages API, forwarded to Claude in Amazon
 * Bedrock with the Lambda role's credentials. The desktop app talks to this
 * route with the regular Anthropic SDK, so request and response bodies, SSE
 * events, and error shapes are the API's own.
 */

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Bedrock behind a small interface (a test seam). */
export interface ModelGateway {
  /** Resolves once Bedrock accepts the request; errors before any event throw here. */
  stream(params: Record<string, unknown>): Promise<AsyncIterable<StreamEvent>>;
  /** A complete message, for clients that don't stream. */
  create(params: Record<string, unknown>): Promise<unknown>;
}

export interface UsageLog {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Fields Bedrock doesn't support; dropped so a client can't trip them. */
const UNSUPPORTED_FIELDS = ["fallbacks", "speed", "inference_geo", "container", "mcp_servers", "stream"];

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
};

export async function handleMessages(
  req: ProxyRequest,
  user: string,
  deps: { config: ProxyConfig; images: ImageStore; models: ModelGateway; log(entry: Record<string, unknown>): void },
): Promise<ProxyResponse> {
  const body = parseJsonBody(req.body);
  if (!isObject(body)) throw new HttpError(400, "invalid_request_error", "The request body must be a JSON object.");
  const model = typeof body.model === "string" ? body.model.replace(/^anthropic\./, "") : "";
  if (!deps.config.allowedModels.includes(model)) {
    throw new HttpError(
      400,
      "invalid_request_error",
      `The model "${model}" isn't allowed on this service. Allowed models: ${deps.config.allowedModels.join(", ")}.`,
    );
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "invalid_request_error", "messages must be an array.");
  }

  const params: Record<string, unknown> = { ...body, model: `anthropic.${model}` };
  for (const field of UNSUPPORTED_FIELDS) delete params[field];
  const requested = typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : deps.config.maxOutputTokens;
  params.max_tokens = Math.min(Math.floor(requested), deps.config.maxOutputTokens);
  const images = await inlineImages(params.messages, user, deps.images);

  const logUsage = (usage: UsageLog, stream: boolean, outcome: string) =>
    deps.log({ route: "messages", user, model, stream, images, outcome, ...usage });

  if (body.stream === true) {
    const events = await deps.models.stream(params).catch(upstreamError);
    return {
      status: 200,
      headers: SSE_HEADERS,
      stream: toServerSentEvents(events, (usage, outcome) => logUsage(usage, true, outcome)),
    };
  }
  const message = await deps.models.create(params).catch(upstreamError);
  logUsage(isObject(message) && isObject(message.usage) ? (message.usage as UsageLog) : {}, false, "ok");
  return json(200, message);
}

/** Relay events as SSE; an error mid-stream becomes an `error` event, as the API sends it. */
export async function* toServerSentEvents(
  events: AsyncIterable<StreamEvent>,
  onDone: (usage: UsageLog, outcome: string) => void,
): AsyncIterable<string> {
  const usage: UsageLog = {};
  let outcome = "ok";
  try {
    for await (const event of events) {
      collectUsage(event, usage);
      yield `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    }
  } catch (err) {
    const { type, message } = describeUpstream(err);
    outcome = `error:${type}`;
    yield `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`;
  } finally {
    onDone(usage, outcome);
  }
}

function collectUsage(event: StreamEvent, usage: UsageLog): void {
  const source =
    event.type === "message_start" && isObject(event.message)
      ? event.message.usage
      : event.type === "message_delta"
        ? event.usage
        : null;
  if (!isObject(source)) return;
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    if (typeof source[key] === "number") usage[key] = source[key];
  }
}

function describeUpstream(err: unknown): { status: number; type: ErrorType; message: string } {
  const status = isObject(err) && typeof err.status === "number" ? err.status : 502;
  // The Anthropic SDK keeps the API's error body on `error`.
  const body = isObject(err) && isObject(err.error) && isObject(err.error.error) ? err.error.error : null;
  const type = typeof body?.type === "string" ? (body.type as ErrorType) : errorTypeFor(status);
  const message = typeof body?.message === "string" ? body.message : errorMessage(err);
  return { status, type, message };
}

function upstreamError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  const { status, type, message } = describeUpstream(err);
  throw new HttpError(status, type, `Bedrock: ${message}`);
}

/** The production gateway: Claude in Amazon Bedrock, signed with the Lambda role. */
export class MantleGateway implements ModelGateway {
  private readonly client: AnthropicBedrockMantle;

  constructor(config: ProxyConfig) {
    this.client = new AnthropicBedrockMantle({
      awsRegion: config.bedrockRegion,
      // Never pick up a bearer token from the environment; sign with the role.
      apiKey: null,
      // Bedrock has no server-side fallback, so a refused request is retried here.
      middleware: config.fallbackModel
        ? [betaRefusalFallbackMiddleware([{ model: `anthropic.${config.fallbackModel}` }])]
        : [],
    });
  }

  async stream(params: Record<string, unknown>): Promise<AsyncIterable<StreamEvent>> {
    const body = { ...params, stream: true } as unknown as MessageCreateParamsStreaming;
    return (await this.client.beta.messages.create(body)) as unknown as AsyncIterable<StreamEvent>;
  }

  create(params: Record<string, unknown>): Promise<unknown> {
    // Streamed upstream even for non-streaming clients, so long turns can't hit HTTP timeouts.
    return this.client.beta.messages.stream(params as unknown as BetaMessageStreamParams).finalMessage();
  }
}
