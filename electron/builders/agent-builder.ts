import { createLogger } from "../logger";
import { RuntimeHolder } from "../llm/runtime";
import type { AgentRuntime, AgentSession } from "../llm/types";

/**
 * Shared plumbing for the final-stage, multi-turn builders (Skill Builder and
 * Automation Builder). Owns one lazily-started model runtime and a small pool of
 * live conversations — one per recording — so each build's plan → refine →
 * create flow stays in a single session. Subclasses add the build-specific tools,
 * system prompt, and `build`/`create` turns; everything below is common.
 */

/** The minimum every live build carries so the pool can manage it. */
export interface BaseLive {
  sessionId: string;
  agent: AgentSession;
}

const MAX_LIVE_SESSIONS = 4;

export abstract class AgentBuilder<TLive extends BaseLive> {
  private readonly runtime: RuntimeHolder;
  protected readonly live = new Map<string, TLive>();
  protected readonly active = new Set<string>();
  protected readonly log;

  /** @param name Used for logs and the startup-timeout messages. */
  constructor(name: string) {
    this.log = createLogger(name);
    this.runtime = new RuntimeHolder(name);
  }

  isBuilding(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** True while any build step is running. */
  isBusy(): boolean {
    return this.active.size > 0;
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) await live.agent.abort().catch(() => undefined);
  }

  async forget(sessionId: string): Promise<void> {
    await this.disposeLive(sessionId);
  }

  async evictIdle(): Promise<void> {
    for (const [id, live] of this.live) {
      if (this.active.has(id)) continue;
      this.live.delete(id);
      await live.agent.disconnect().catch(() => undefined);
    }
  }

  /** Drop every conversation and the runtime so the next build uses the current
   *  AI settings. Prepared skill previews are plain files and stay valid. */
  async resetRuntime(): Promise<void> {
    for (const [id] of this.live) await this.disposeLive(id);
    await this.runtime.stop();
  }

  async dispose(): Promise<void> {
    await this.resetRuntime();
  }

  /** Start (once) and return the shared runtime, verifying the backend is ready. */
  protected async ensureRuntime(): Promise<AgentRuntime> {
    return this.runtime.get();
  }

  /** Add a freshly created live session to the pool, evicting the oldest idle one
   *  when the pool is over budget. */
  protected registerLive(live: TLive): void {
    this.live.set(live.sessionId, live);
    for (const [id, l] of this.live) {
      if (this.live.size <= MAX_LIVE_SESSIONS) break;
      if (id === live.sessionId || this.active.has(id)) continue;
      this.live.delete(id);
      void l.agent.disconnect().catch(() => undefined);
    }
  }

  protected async disposeLive(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    await live.agent.disconnect().catch(() => undefined);
  }
}
