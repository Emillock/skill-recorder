import type { AgentTool } from "../llm/types";

import {
  AutomationPlanSchema,
  type AutomationPlan,
} from "../../common/automation";
import type { SkillArchitecture } from "../../common/skill";

/** Everything the builder's automation-specific tools are bound to for one session. */
export interface AutomationToolContext {
  architecture: SkillArchitecture;
  /** Streamed to the UI as the agent works. */
  onProgress?: (message: string) => void;
  /** Called when the agent proposes a (validated) plan for review. */
  onPlan: (plan: AutomationPlan) => void;
}

/** A wall-clock time-of-day object, reused across the schedule fields. */
const timeOfDay = (description: string) => ({
  type: "object" as const,
  description,
  properties: {
    hour: { type: "integer" as const, minimum: 0, maximum: 23 },
    minute: { type: "integer" as const, minimum: 0, maximum: 59 },
  },
  required: ["hour", "minute"],
  additionalProperties: false,
});

/**
 * A schedule object. Modelled loosely for the tool call (all kind-specific fields are
 * optional here); the zod discriminated union enforces the right combination per `kind`
 * server-side. `single` → `time`; `interval` → `intervalMinutes` + `anchor`;
 * `multi` → `times[]`.
 */
const scheduleSchema = {
  type: "object" as const,
  description:
    "The run schedule. Set `kind` and the matching fields, plus `naturalLanguage` (human phrasing) and optional `days` (0=Sun…6=Sat; empty = every day).",
  properties: {
    kind: {
      type: "string" as const,
      enum: ["single", "interval", "multi"],
      description: "single = one time/day; interval = every N minutes; multi = several fixed times/day.",
    },
    naturalLanguage: {
      type: "string" as const,
      description: 'Human phrasing of the schedule, e.g. "every weekday at 9am".',
    },
    days: {
      type: "array" as const,
      items: { type: "integer" as const, minimum: 0, maximum: 6 },
      description: "Weekdays it runs (0=Sun…6=Sat). Empty/omitted = every day.",
    },
    time: timeOfDay("For kind=single: the single time of day it runs."),
    intervalMinutes: {
      type: "integer" as const,
      minimum: 1,
      maximum: 1440,
      description: "For kind=interval: minutes between runs; must divide 1440 evenly (e.g. 15, 30, 60, 120).",
    },
    anchor: timeOfDay("For kind=interval: the first run of the day (the interval anchor)."),
    times: {
      type: "array" as const,
      items: timeOfDay("A time of day it runs."),
      description: "For kind=multi: the fixed times of day it runs.",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

const stepsSchema = {
  type: "array" as const,
  description: "The generalized procedure as ordered steps; each step is a label + an NL prompt to the agent.",
  items: {
    type: "object" as const,
    properties: {
      label: { type: "string" as const, description: 'Short label for the step, e.g. "Collect new leads".' },
      prompt: {
        type: "string" as const,
        description:
          "The natural-language instruction to the agent for this step: generalized over the whole collection, native-tool-first, and self-resolving (an automation runs unattended). Reference any fixed value by its {{id}} token instead of writing the literal (e.g. \"gh pr list -R {{repo}}\").",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/**
 * Build the automation-specific tools exposed to one Automation Builder session. The
 * agent reads the recording via the shared read-tools (get_analysis / get_timeline),
 * then proposes a reviewable plan (propose_automation_plan) with a default schedule and
 * STOPS. The reviewed plan is the whole payload — the build is deterministic, so there is
 * no separate submit tool. The plan is zod-validated; the architecture is injected
 * server-side.
 */
export function createAutomationBuilderTools(ctx: AutomationToolContext): AgentTool[] {
  const { architecture, onPlan } = ctx;
  const progress = (m: string) => ctx.onProgress?.(m);

  const proposePlan: AgentTool = {
    name: "propose_automation_plan",
    description:
      "Propose your reviewable plan for the automation: how you'll generalize the task, the trigger (propose a sensible default schedule), the fixed values it hard-codes (each referenced by a {{id}} token in the step prompts), and the generalized ordered prompt-steps. Call this once per turn, then STOP so the user can review or refine it (especially the schedule).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: 'kebab-case automation id, e.g. "daily-lead-digest".' },
        title: { type: "string", description: 'Human-friendly title, e.g. "Daily lead digest".' },
        description: {
          type: "string",
          description: "What the automation does and when it runs (becomes the automation description).",
        },
        summary: { type: "string", description: "Plain-language summary of what the automation does." },
        generalization: {
          type: "string",
          description: "How the recorded specifics become a repeatable procedure (the loop/collection insight).",
        },
        trigger: {
          type: "object",
          description: "The trigger. Default to a schedule; use a condition only when the recording implies an event.",
          properties: {
            type: {
              type: "string",
              enum: ["schedule", "condition"],
              description: "schedule (default) or condition.",
            },
            schedule: scheduleSchema,
            condition: {
              type: "string",
              description: "For type=condition: the NL condition to check before running.",
            },
            conditionCheckInterval: {
              type: "integer",
              minimum: 1,
              description: "For type=condition: minutes between condition checks.",
            },
          },
          required: ["schedule"],
          additionalProperties: false,
        },
        values: {
          type: "array",
          description:
            "Genuinely FIXED literals the procedure hard-codes — a canonical URL, file path, repo slug, or constant that is the SAME every run. Each becomes an inline, editable pill in the review UI and is substituted for its {{id}} token when the automation is built. Do NOT create a value for anything discovered at run time or that varies run-to-run — write those as plain step instructions.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "snake_case token key referenced in step prompts as {{id}}, e.g. \"repo\".",
              },
              name: {
                type: "string",
                description: "Short human label shown on the pill, e.g. \"Target repo\".",
              },
              value: {
                type: "string",
                description: "The exact fixed literal (the URL / path / repo slug / constant).",
              },
            },
            required: ["id", "name", "value"],
            additionalProperties: false,
          },
        },
        steps: stepsSchema,
        model: { type: "string", description: "Optional per-automation model override." },
        skillNames: {
          type: "array",
          items: { type: "string" },
          description: "Built-in Scout skills the steps rely on (for the user's awareness).",
        },
      },
      required: ["name", "title", "description", "trigger"],
      additionalProperties: false,
    },
    handler: (raw) => {
      const merged = { ...(raw as Record<string, unknown>), architecture };
      const parsed = AutomationPlanSchema.safeParse(merged);
      if (!parsed.success) {
        return {
          textResultForLlm:
            "propose_automation_plan rejected — the payload did not match the schema. Fix these and call again:\n" +
            parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
          resultType: "failure",
        };
      }
      progress("Proposed an automation plan for your review.");
      onPlan(parsed.data);
      return "Plan recorded and shown to the user. Stop now and wait for their review or refinement.";
    },
  };

  return [proposePlan];
}
