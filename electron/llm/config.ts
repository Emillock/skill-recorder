import type { AiProvider } from "./types";

/**
 * Which model backend the agents use, resolved at the moment a runtime is
 * created. Environment variables win over saved settings so evals and
 * development runs can point at a backend without touching the app's settings:
 *
 * - `SKILL_RECORDER_PROVIDER`    `aws` (default) or `copilot`
 * - `SKILL_RECORDER_PROXY_URL`   base URL of the Skill Recorder service on AWS
 * - `SKILL_RECORDER_PROXY_TOKEN` access token for that service
 * - `SKILL_RECORDER_MODEL`       model override (Claude model ID for `aws`)
 * - `SKILL_RECORDER_EFFORT`      `low` | `medium` | `high` (default) | `xhigh` | `max`
 */
export interface AiConfig {
  provider: AiProvider;
  /** AWS only: base URL of the proxy, without a trailing slash. */
  proxyUrl: string;
  /** AWS only: the user's access token for the proxy. */
  proxyToken: string;
  /** AWS only: Claude model ID; empty means {@link DEFAULT_AWS_MODEL}. */
  model: string;
}

export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_PROVIDER: AiProvider = "aws";
export const DEFAULT_AWS_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: AiEffort = "high";

/** Settings saved by the app; any field may be missing. */
export type StoredAiConfig = Partial<AiConfig>;

let storedConfig: () => StoredAiConfig = () => ({});

/** Called once by the main process so runtimes see the user's saved settings. */
export function setStoredAiConfigSource(source: () => StoredAiConfig): void {
  storedConfig = source;
}

export function parseProvider(value: unknown): AiProvider | null {
  return value === "aws" || value === "copilot" ? value : null;
}

export function normalizeProxyUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const stored = storedConfig();
  return {
    provider: parseProvider(env.SKILL_RECORDER_PROVIDER) ?? parseProvider(stored.provider) ?? DEFAULT_PROVIDER,
    proxyUrl: normalizeProxyUrl(env.SKILL_RECORDER_PROXY_URL || stored.proxyUrl || ""),
    proxyToken: (env.SKILL_RECORDER_PROXY_TOKEN || stored.proxyToken || "").trim(),
    model: (env.SKILL_RECORDER_MODEL || stored.model || "").trim(),
  };
}

export function resolveEffort(env: NodeJS.ProcessEnv = process.env): AiEffort {
  const value = env.SKILL_RECORDER_EFFORT;
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : DEFAULT_EFFORT;
}

/** Names of the environment variables currently overriding saved settings. */
export function aiEnvOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "SKILL_RECORDER_PROVIDER",
    "SKILL_RECORDER_PROXY_URL",
    "SKILL_RECORDER_PROXY_TOKEN",
    "SKILL_RECORDER_MODEL",
  ].filter((name) => Boolean(env[name]));
}
