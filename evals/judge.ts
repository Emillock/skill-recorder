// Optional semantic judge: asks an agent (on the configured AI backend) to rate how faithfully the
// describer's analysis captures the scenario's ground-truth task. Off by default
// (`--judge`); the deterministic rubric in scoring.ts is the primary signal. This
// adds a qualitative, human-like second opinion for the overnight report.

import os from "node:os";

import type { Analysis } from "../common/analysis";
import { createAgentRuntime } from "../electron/llm/runtime";
import type { AgentTool } from "../electron/llm/types";
import type { Scenario } from "./scenario";

export interface JudgeResult {
  score: number;
  max: number;
  verdict: string;
  reasons: string;
}

const JUDGE_INSTRUCTIONS = `
You are grading an AI system that reconstructs "what a user did" from captured OS
events. You are given (1) the ground-truth description of the task and (2) the
system's produced intent + ordered steps. Judge how faithfully the produced
analysis captures the real task: correct overall intent, right key actions in the
right order, no invented steps, and no leftover recorder/tool noise. Then call
submit_judgement exactly once. Do not reply with prose.
`.trim();

function renderPrompt(scenario: Scenario, a: Analysis): string {
  const steps = a.steps.map((s, i) => `${i + 1}. ${s.title} — ${s.detail}`).join("\n");
  return [
    `GROUND TRUTH (what the user actually did):`,
    scenario.truth,
    ``,
    `PRODUCED ANALYSIS:`,
    `intent (${a.intentConfidence}): ${a.intent}`,
    `steps:`,
    steps || "(none)",
    ``,
    `Grade faithfulness from 0 (wrong/unusable) to 5 (accurate and complete), then call submit_judgement.`,
  ].join("\n");
}

/** Uses the same backend and model override (SKILL_RECORDER_MODEL) as the run. */
export async function judgeAnalysis(scenario: Scenario, analysis: Analysis): Promise<JudgeResult> {
  const runtime = createAgentRuntime("Judge");
  await runtime.start();
  try {
    const holder: { result: JudgeResult | undefined } = { result: undefined };
    const submit: AgentTool = {
      name: "submit_judgement",
      description: "Submit your final faithfulness grade (0–5) for the produced analysis.",
      parameters: {
        type: "object",
        properties: {
          score: { type: "number", description: "0–5 faithfulness grade." },
          verdict: { type: "string", description: "A few words, e.g. 'accurate' or 'missed the paste step'." },
          reasons: { type: "string", description: "1–3 sentences justifying the grade." },
        },
        required: ["score", "verdict"],
        additionalProperties: false,
      },
      handler: (raw) => {
        const r = (raw ?? {}) as { score?: number; verdict?: string; reasons?: string };
        holder.result = {
          score: Math.max(0, Math.min(5, Number(r.score) || 0)),
          max: 5,
          verdict: r.verdict ?? "",
          reasons: r.reasons ?? "",
        };
        return "Judgement recorded.";
      },
    };

    const session = await runtime.createSession({
      systemMessage: JUDGE_INSTRUCTIONS,
      tools: [submit],
      workingDirectory: os.tmpdir(),
    });
    await session.sendAndWait(renderPrompt(scenario, analysis), 120_000);
    await session.disconnect().catch(() => undefined);
    if (!holder.result) throw new Error("judge did not submit a grade");
    return holder.result;
  } finally {
    await runtime.stop().catch(() => undefined);
  }
}
