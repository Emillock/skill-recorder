import { approveAll, CopilotClient, type CopilotSession } from "@github/copilot-sdk";

import { COPILOT_SIGNED_OUT_ERROR } from "../../common/ipc";
import { copilotConnectionOption, withStartupTimeout } from "../copilot-cli-path";
import { createLogger } from "../logger";
import type {
  AgentRuntime,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
} from "./types";

const log = createLogger("CopilotRuntime");

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface CopilotRuntimeOptions {
  /** Pick a vision-capable model when no override is set (the describer views frames). */
  preferVisionModel?: boolean;
}

/** Runs agents on the bundled GitHub Copilot CLI. */
export class CopilotRuntime implements AgentRuntime {
  readonly provider = "copilot";
  readonly turnTimeoutMs = 180_000;
  private client: CopilotClient | null = null;
  private model: string | undefined;

  /** @param label Used for logs and the startup-timeout message. */
  constructor(
    private readonly label: string,
    private readonly options: CopilotRuntimeOptions = {},
  ) {}

  async start(): Promise<AgentRuntimeInfo> {
    const client = new CopilotClient(copilotConnectionOption());
    await withStartupTimeout(client.start(), `Copilot CLI (${this.label})`);
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) {
      await client.stop().catch(() => undefined);
      throw new Error(COPILOT_SIGNED_OUT_ERROR);
    }
    this.model = this.options.preferVisionModel
      ? await pickVisionModel(client)
      : process.env.SKILL_RECORDER_MODEL || undefined;
    this.client = client;
    return { account: auth.login, model: this.model };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    if (!this.client) throw new Error("The Copilot runtime has not been started.");
    // Always constrain the agent to our sandboxed custom tools. If the runtime
    // cannot honor the allowlist we fail rather than silently creating an
    // unsandboxed session — which, combined with approveAll, would auto-run the
    // SDK's full default toolset in the user's environment.
    const session = await this.client.createSession({
      systemMessage: { mode: "append", content: config.systemMessage },
      tools: config.tools,
      onPermissionRequest: approveAll,
      workingDirectory: config.workingDirectory,
      enableHostGitOperations: false,
      infiniteSessions: { enabled: false },
      availableTools: config.tools.map((t) => t.name),
      ...(this.model ? { model: this.model } : {}),
    });
    return new CopilotAgentSession(session, this.turnTimeoutMs);
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.stop().catch(() => undefined);
  }
}

class CopilotAgentSession implements AgentSession {
  constructor(
    private readonly session: CopilotSession,
    private readonly defaultTimeoutMs: number,
  ) {}

  async sendAndWait(prompt: string, timeoutMs = this.defaultTimeoutMs): Promise<void> {
    await this.session.sendAndWait(prompt, timeoutMs);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  disconnect(): Promise<void> {
    return this.session.disconnect();
  }
}

/** Prefer a vision-capable, enabled model (frames need vision). */
async function pickVisionModel(client: CopilotClient): Promise<string | undefined> {
  const override = process.env.SKILL_RECORDER_MODEL;
  if (override) return override;
  try {
    const models = await client.listModels();
    const vision = models.filter(
      (m) => m.capabilities?.supports?.vision && m.policy?.state !== "disabled",
    );
    return vision[0]?.id;
  } catch (err) {
    log.warn("listModels failed; using CLI default model:", msg(err));
    return undefined;
  }
}
