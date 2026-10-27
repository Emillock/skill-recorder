import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AgentTool } from "../llm/types";

import type { Analysis } from "../../common/analysis";
import type { SessionBundle } from "../../common/bundle";

/**
 * The two read-only tools every final-stage builder exposes: `get_analysis`
 * (the approved intent + steps the builder generalizes) and `get_timeline` (the
 * deterministic evidence behind those steps). Shared by the Skill Builder and the
 * Automation Builder so both ground their plans in the same recording data.
 */

export function readBundle(sessionDir: string): SessionBundle | null {
  const p = path.join(sessionDir, "bundle.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SessionBundle;
  } catch {
    return null;
  }
}

export interface ReadToolsContext {
  sessionDir: string;
  /** The approved analysis being generalized (the builder's input). */
  analysis: Analysis;
  /** Streamed to the UI as the agent works. */
  onProgress?: (message: string) => void;
}

/** Build the shared `get_analysis` + `get_timeline` tools for one builder session. */
export function createReadTools(ctx: ReadToolsContext): AgentTool[] {
  const { sessionDir, analysis } = ctx;
  const progress = (m: string) => ctx.onProgress?.(m);

  const getAnalysis: AgentTool = {
    name: "get_analysis",
    description:
      "Return the approved analysis you are generalizing: the overall intent and the ordered list of steps (with each step's title, detail, apps, and evidence). Read this first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      progress("Reading the approved analysis…");
      const view = {
        intent: analysis.intent,
        intentRationale: analysis.intentRationale,
        stepCount: analysis.steps.length,
        steps: analysis.steps.map((s) => ({
          id: s.id,
          title: s.title,
          detail: s.detail,
          apps: s.apps,
          evidence: s.evidence,
        })),
      };
      return JSON.stringify(view, null, 2);
    },
  };

  const getTimeline: AgentTool = {
    name: "get_timeline",
    description:
      "Return the deterministic timeline behind the analysis: ordered steps with their app, window titles, hosts, URLs, terminal commands, clipboard counts and markers. Use it to ground your native-tool mapping in real evidence.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      progress("Reading the timeline…");
      const bundle = readBundle(sessionDir);
      if (!bundle) {
        return "No timeline is available (bundle.json missing). Work from get_analysis instead.";
      }
      const view = {
        durationMs: bundle.session.durationMs,
        platform: bundle.session.platform,
        steps: bundle.steps.map((s) => ({
          index: s.index,
          app: s.app,
          titles: s.titles,
          hosts: s.hosts,
          urls: s.urls,
          commands: s.commands,
          clipboardCount: s.clipboardCount,
          markers: s.markers,
          summary: s.summary,
        })),
      };
      return JSON.stringify(view, null, 2);
    },
  };

  return [getAnalysis, getTimeline];
}
