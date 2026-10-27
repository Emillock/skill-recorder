import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaImageBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import {
  AWS_PROXY_NOT_CONFIGURED_ERROR,
  AWS_PROXY_TOKEN_REJECTED_ERROR,
} from "../../common/ipc";
import { DEFAULT_AWS_MODEL, resolveEffort, type AiConfig, type AiEffort } from "./config";
import { ProxyApi } from "./proxy-api";
import type {
  AgentRuntime,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentTool,
  AgentToolResult,
} from "./types";

/**
 * Runs agents on Claude through the organization's Skill Recorder service on AWS
 * (see `proxy/`). The service holds the AWS credentials and forwards Messages API
 * requests to Amazon Bedrock; this side keeps each conversation and runs the
 * tools locally, since they read the recording on this computer.
 *
 * Screen frames are uploaded once to the service and referenced by id, so each
 * request stays small even though the whole conversation is resent every call.
 */

/** Room for adaptive thinking plus a full tool call; streamed, so no HTTP timeout. */
const MAX_OUTPUT_TOKENS = 32_000;
/** Model calls one user turn may make before we stop a runaway tool loop. */
const MAX_MODEL_CALLS_PER_TURN = 40;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The part of the Anthropic client the session uses (a test seam). */
export interface MessagesApi {
  stream(params: BetaMessageStreamParams, options: { signal: AbortSignal }): { finalMessage(): Promise<BetaMessage> };
}

export interface ProxySessionDeps {
  messages: MessagesApi;
  uploadImage(base64: string, mimeType: string, signal: AbortSignal): Promise<string>;
  model: string;
  effort: AiEffort;
  defaultTimeoutMs: number;
}

export interface ProxyRuntimeDeps {
  fetch?: typeof fetch;
  createMessages?: (config: AiConfig) => MessagesApi;
}

export class ProxyRuntime implements AgentRuntime {
  readonly provider = "aws";
  /** Claude turns with several tool calls and image reads can run for minutes. */
  readonly turnTimeoutMs = 600_000;
  private api: ProxyApi | null = null;
  private messages: MessagesApi | null = null;
  private model = DEFAULT_AWS_MODEL;

  constructor(
    private readonly label: string,
    private readonly config: AiConfig,
    private readonly deps: ProxyRuntimeDeps = {},
  ) {}

  async start(): Promise<AgentRuntimeInfo> {
    const { proxyUrl, proxyToken } = this.config;
    if (!proxyUrl || !proxyToken) throw new Error(AWS_PROXY_NOT_CONFIGURED_ERROR);
    const api = new ProxyApi(proxyUrl, proxyToken, this.deps.fetch);
    const health = await api.health();
    const model = this.config.model || DEFAULT_AWS_MODEL;
    if (health.allowedModels.length && !health.allowedModels.includes(model)) {
      throw new Error(
        `The Skill Recorder service doesn't allow the model "${model}". ` +
          `Choose one of: ${health.allowedModels.join(", ")}.`,
      );
    }
    this.api = api;
    this.model = model;
    this.messages = this.deps.createMessages?.(this.config) ?? createMessagesApi(this.config);
    return { account: health.user || undefined, model };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const api = this.api;
    const messages = this.messages;
    if (!api || !messages) throw new Error(`The AWS runtime (${this.label}) has not been started.`);
    return new ProxySession(config, {
      messages,
      uploadImage: (data, mimeType, signal) => api.uploadImage(data, mimeType, signal),
      model: this.model,
      effort: resolveEffort(),
      defaultTimeoutMs: this.turnTimeoutMs,
    });
  }

  async stop(): Promise<void> {
    this.api = null;
    this.messages = null;
  }
}

function createMessagesApi(config: AiConfig): MessagesApi {
  // An explicit apiKey stops the SDK from reading ANTHROPIC_* variables or local
  // profiles, so no other credential is ever sent to the proxy.
  const client = new Anthropic({ baseURL: config.proxyUrl, apiKey: config.proxyToken });
  return {
    stream: (params, options) => client.beta.messages.stream(params, options),
  };
}

/**
 * One conversation. The full history lives here (the API is stateless) and is
 * only ever appended to; a failed or canceled turn is rolled back to where it
 * started so the next turn continues from a valid conversation.
 */
export class ProxySession implements AgentSession {
  private readonly history: BetaMessageParam[] = [];
  private readonly tools: BetaTool[];
  private readonly toolsByName: Map<string, AgentTool>;
  private readonly system: string;
  private controller: AbortController | null = null;

  constructor(config: AgentSessionConfig, private readonly deps: ProxySessionDeps) {
    this.system = config.systemMessage;
    this.toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
    this.tools = config.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as BetaTool.InputSchema,
    }));
  }

  async sendAndWait(prompt: string, timeoutMs = this.deps.defaultTimeoutMs): Promise<void> {
    if (this.controller) throw new Error("A turn is already running in this conversation.");
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(
      () => controller.abort(new Error(`The model did not finish within ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs,
    );
    const checkpoint = this.history.length;
    try {
      this.history.push({ role: "user", content: prompt });
      for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
        const response = await this.deps.messages
          .stream(this.params(), { signal: controller.signal })
          .finalMessage();
        // Echo the assistant content back unchanged (thinking blocks included).
        this.history.push({ role: "assistant", content: response.content });
        switch (response.stop_reason) {
          case "tool_use": {
            const results = await this.runTools(response.content, controller.signal);
            if (results.length === 0) return;
            this.history.push({ role: "user", content: results });
            continue;
          }
          case "refusal":
            throw new Error(refusalMessage(response));
          case "max_tokens":
            throw new Error("The model's reply was cut off before it finished. Try again.");
          case "end_turn":
          case "stop_sequence":
          case "pause_turn":
          case null:
            return;
          default:
            throw new Error(`The model stopped unexpectedly (${response.stop_reason}).`);
        }
      }
      throw new Error(`The model made more than ${MAX_MODEL_CALLS_PER_TURN} calls in one turn; stopping.`);
    } catch (err) {
      this.history.length = checkpoint;
      if (controller.signal.aborted) {
        const reason: unknown = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error("Canceled.");
      }
      throw describeError(err);
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }

  async abort(): Promise<void> {
    this.controller?.abort(new Error("Canceled."));
  }

  async disconnect(): Promise<void> {
    await this.abort();
    this.history.length = 0;
  }

  private params(): BetaMessageStreamParams {
    return {
      model: this.deps.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // The system prompt and tool list never change within a conversation, and
      // top-level caching extends the cached prefix as the history grows, so each
      // call pays full price only for what was added since the last one.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      tools: this.tools,
      messages: this.history,
      output_config: { effort: this.deps.effort },
    };
  }

  /** Run every tool call in the response and return all results in one user message. */
  private async runTools(
    content: BetaContentBlock[],
    signal: AbortSignal,
  ): Promise<BetaToolResultBlockParam[]> {
    const results: BetaToolResultBlockParam[] = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      signal.throwIfAborted();
      results.push(await this.runTool(block, signal));
    }
    return results;
  }

  private async runTool(block: BetaToolUseBlock, signal: AbortSignal): Promise<BetaToolResultBlockParam> {
    const tool = this.toolsByName.get(block.name);
    if (!tool) {
      return { type: "tool_result", tool_use_id: block.id, content: `Unknown tool "${block.name}".`, is_error: true };
    }
    let result: AgentToolResult;
    try {
      result = await tool.handler(block.input);
    } catch (err) {
      return { type: "tool_result", tool_use_id: block.id, content: `The tool failed: ${msg(err)}`, is_error: true };
    }
    if (typeof result === "string") {
      return { type: "tool_result", tool_use_id: block.id, content: result || "(empty result)" };
    }
    const parts: (BetaTextBlockParam | BetaImageBlockParam)[] = [
      { type: "text", text: result.textResultForLlm || "(no text result)" },
    ];
    for (const image of result.binaryResultsForLlm ?? []) {
      if (image.type !== "image") continue;
      const fileId = await this.deps.uploadImage(image.data, image.mimeType, signal);
      if (image.description) parts.push({ type: "text", text: image.description });
      parts.push({ type: "image", source: { type: "file", file_id: fileId } });
    }
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: parts,
      ...(result.resultType === "failure" ? { is_error: true } : {}),
    };
  }
}

function refusalMessage(response: BetaMessage): string {
  const category = response.stop_details?.category;
  return category
    ? `The model declined this request (${category}). Try rephrasing your feedback or recording again.`
    : "The model declined this request. Try rephrasing your feedback or recording again.";
}

/** Turn SDK failures into messages the app shows as-is. */
function describeError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new Error(AWS_PROXY_TOKEN_REJECTED_ERROR);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error(`Can't reach the Skill Recorder service on AWS: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`The Skill Recorder service returned an error${err.status ? ` (${err.status})` : ""}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
