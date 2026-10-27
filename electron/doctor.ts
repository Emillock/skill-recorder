import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { CAPTURE_SOURCES, FULL_CAPTURE } from "../common/config";
import type {
  ActiveWindowInfo,
  BrowserUrlInfo,
  CopilotInfo,
  DoctorReport,
  DoctorSource,
} from "../common/ipc";
import { browserUrlProviderKind } from "./collectors/url-provider";
import { resolveCopilotCliPath } from "./copilot-cli-path";
import { resolveAiConfig } from "./llm/config";
import { sessionsRoot } from "./recorder/session-store";

const require = createRequire(import.meta.url);

function which(cmd: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, [cmd], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
}

function checkCopilot(): CopilotInfo {
  // The app ships its own Copilot CLI in node_modules, so a global `copilot` on PATH is
  // optional — check the bundled binary first or one-liner installs look broken here.
  const p = resolveCopilotCliPath() ?? which("copilot");
  return { ok: Boolean(p), path: p ?? null };
}

function checkActiveWindow(): ActiveWindowInfo {
  try {
    if (process.platform === "win32") {
      const modulePath = require.resolve("koffi");
      require("koffi");
      return { ok: true, provider: "koffi", path: modulePath };
    }
    const modulePath = require.resolve("get-windows");
    return { ok: existsSync(modulePath), provider: "get-windows", path: modulePath };
  } catch (err) {
    return {
      ok: false,
      provider: "missing",
      path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkBrowserUrl(): BrowserUrlInfo {
  const kind = browserUrlProviderKind();
  return { kind, supported: kind !== "none" };
}

/** Whether a capture source can work at all on the current platform. */
function sourceSupport(key: string, browserUrl: BrowserUrlInfo): { supported: boolean; note?: string } {
  if (key === "browserUrls" && !browserUrl.supported) {
    return { supported: false, note: "Not available on this platform" };
  }
  return { supported: true };
}

/** Environment readiness check surfaced in the UI and (later) a CLI `doctor` command. */
export function runDoctor(): DoctorReport {
  const config = FULL_CAPTURE;
  const browserUrl = checkBrowserUrl();

  const activeSources: DoctorSource[] = CAPTURE_SOURCES.filter((s) => config[s.key]).map((s) => {
    const support = sourceSupport(s.key, browserUrl);
    return { key: s.key, label: s.label, tier: s.tier, cost: s.cost, supported: support.supported, note: support.note };
  });

  const copilotCli = checkCopilot();
  const ai = resolveAiConfig();
  return {
    platform: process.platform,
    ai: {
      provider: ai.provider,
      configured: ai.provider === "copilot" ? copilotCli.ok : Boolean(ai.proxyUrl && ai.proxyToken),
    },
    copilotCli,
    activeWindow: checkActiveWindow(),
    browserUrl,
    sessionsDir: sessionsRoot(),
    activeSources,
  };
}
