/**
 * Provider-neutral contract between Skill Recorder's agents (describer, skill and
 * automation builders) and the model backend that runs them. Each agent supplies
 * its own sandboxed tools and system prompt; a runtime only drives the tool loop.
 *
 * Two runtimes implement it: GitHub Copilot (the bundled CLI) and the AWS proxy
 * (Claude on Amazon Bedrock behind the organization's Skill Recorder service).
 */

import type { AiProvider } from "../../common/ipc";

export type { AiProvider };

export interface AgentToolImage {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  type: "image";
  /** Short caption placed next to the image for the model. */
  description?: string;
}

export interface AgentToolResultObject {
  textResultForLlm: string;
  binaryResultsForLlm?: AgentToolImage[];
  resultType: "success" | "failure";
}

export type AgentToolResult = string | AgentToolResultObject;

/** A tool the agent may call. Handlers validate their own arguments. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  handler: (args: unknown) => AgentToolResult | Promise<AgentToolResult>;
}

export interface AgentSessionConfig {
  /** Instructions appended to the runtime's system prompt. */
  systemMessage: string;
  /** The only tools the agent may use; runtimes must not expose any others. */
  tools: AgentTool[];
  /** The recording folder the session works on. */
  workingDirectory: string;
}

/** One multi-turn conversation. Each `sendAndWait` adds a user turn. */
export interface AgentSession {
  /**
   * Send a user message and run the tool loop until the agent ends its turn.
   * Rejects on timeout (default: the runtime's `turnTimeoutMs`), abort, or
   * backend failure.
   */
  sendAndWait(prompt: string, timeoutMs?: number): Promise<void>;
  /** Stop the in-flight turn, if any. */
  abort(): Promise<void>;
  /** Release the conversation. */
  disconnect(): Promise<void>;
}

export interface AgentRuntimeInfo {
  /** Signed-in account or proxy user, for logs. */
  account?: string;
  /** Model the runtime will use, when known. */
  model?: string;
}

export interface AgentRuntime {
  readonly provider: AiProvider;
  /** Default time one `sendAndWait` may take. */
  readonly turnTimeoutMs: number;
  /**
   * Connect and verify credentials. Throws the provider's setup error (see
   * `common/ipc.ts`) when the backend isn't signed in or configured.
   */
  start(): Promise<AgentRuntimeInfo>;
  createSession(config: AgentSessionConfig): Promise<AgentSession>;
  stop(): Promise<void>;
}
