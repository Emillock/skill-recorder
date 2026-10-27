import { createContext, useContext, useEffect, useState } from "react";

import type { AiProvider, AiSettingsStatus } from "../common/ipc";

/** Current AI settings, kept fresh when they change in any window. */
export function useAiSettings(): AiSettingsStatus | null {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  useEffect(() => {
    let live = true;
    void window.skillRecorder.aiSettings().then((next) => {
      if (live) setStatus(next);
    });
    const unsubscribe = window.skillRecorder.onAiSettingsChanged(setStatus);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return status;
}

/** The backend analyses run on now (environment overrides included); AWS until loaded. */
export function useActiveAiProvider(): AiProvider {
  return useAiSettings()?.activeProvider ?? "aws";
}

export function aiBackendName(provider: AiProvider): string {
  return provider === "aws" ? "Claude on AWS" : "GitHub Copilot";
}

/** Where recording data goes when the user chooses Analyze, for privacy copy. */
export function aiDestination(provider: AiProvider): string {
  return provider === "aws"
    ? "your organization's Skill Recorder service on AWS and processed by Claude in Amazon Bedrock"
    : "GitHub's cloud service and processed by GitHub Copilot";
}

/** Lets nested panels (error banners) open the AI settings sheet. */
export const OpenAiSettingsContext = createContext<(() => void) | null>(null);

export function useOpenAiSettings(): (() => void) | null {
  return useContext(OpenAiSettingsContext);
}
