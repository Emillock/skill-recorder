import { createLogger } from "../logger";
import { resolveAiConfig } from "./config";
import { CopilotRuntime } from "./copilot-runtime";
import { ProxyRuntime } from "./proxy-runtime";
import type { AgentRuntime } from "./types";

export interface RuntimeOptions {
  /** The agent views screen frames, so it needs a vision-capable model. */
  preferVisionModel?: boolean;
}

/** Create a runtime for whichever backend the current settings select. */
export function createAgentRuntime(label: string, options: RuntimeOptions = {}): AgentRuntime {
  const config = resolveAiConfig();
  if (config.provider === "copilot") return new CopilotRuntime(label, options);
  return new ProxyRuntime(label, config);
}

/**
 * Lazily starts one runtime and shares it between an agent's conversations.
 * A failed start is not cached, so the next call retries (for example after
 * the user signs in or fixes their settings).
 */
export class RuntimeHolder {
  private runtime: AgentRuntime | null = null;
  private starting: Promise<AgentRuntime> | null = null;
  private readonly log;

  constructor(
    label: string,
    private readonly create: () => AgentRuntime = () => createAgentRuntime(label),
  ) {
    this.log = createLogger(label);
  }

  async get(): Promise<AgentRuntime> {
    if (this.runtime) return this.runtime;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const runtime = this.create();
      const info = await runtime.start();
      this.log.info(
        `${runtime.provider} backend ready`,
        info.account ? `as ${info.account}` : "",
        info.model ? `· model ${info.model}` : "",
      );
      this.runtime = runtime;
      return runtime;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    const pending = this.starting;
    this.starting = null;
    const runtime = this.runtime ?? (pending ? await pending.catch(() => null) : null);
    this.runtime = null;
    if (runtime) await runtime.stop().catch(() => undefined);
  }
}
