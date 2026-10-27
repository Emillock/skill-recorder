import { existsSync, readFileSync } from "node:fs";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readAudioNarrationLanguage,
  readAudioSources,
  type AudioSource,
} from "../../common/audio";
import {
  AWS_PROXY_NOT_CONFIGURED_ERROR,
  type NarrationActionResult,
  type NarrationEngine,
  type NarrationStatus,
} from "../../common/ipc";
import {
  DEFAULT_NARRATION_LANGUAGE,
  isNarrationLanguage,
  NARRATION_FILE,
  type NarrationLanguage,
  type NarrationTranscript,
} from "../../common/narration";
import type { SessionMeta } from "../../common/types";
import { resolveAiConfig } from "../llm/config";
import { ProxyApi } from "../llm/proxy-api";
import { createLogger } from "../logger";
import { isValidSessionId, sessionDir } from "../recorder/session-store";
import { shouldTranscribeBeforeAnalyze } from "./analyze-gate";
import { createRemoteAsrPipeline } from "./remote-asr";
import { transcribeNarration } from "./transcribe";
import {
  getAsrPipeline,
  isNarrationModelCached,
  narrationModelCacheDir,
  removeLegacyNarrationModelCache,
  type ModelLoadProgress,
} from "./whisper";

const log = createLogger("Narration");

/** Recorded in narration.json for transcripts made by the AWS service. */
export const REMOTE_NARRATION_MODEL_ID = "aws-sagemaker";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readTranscript(file: string): NarrationTranscript | null {
  if (!existsSync(file)) return null;
  try {
    const transcript = readJson<NarrationTranscript>(file);
    const language = transcript.language ?? DEFAULT_NARRATION_LANGUAGE;
    return typeof transcript.model === "string" &&
      isNarrationLanguage(language) &&
      Array.isArray(transcript.segments)
      ? { ...transcript, language }
      : null;
  } catch {
    return null;
  }
}

function resolveSessionFile(dir: string, relativeFile: string): string {
  const resolved = path.resolve(dir, relativeFile);
  const prefix = `${path.resolve(dir)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error("Narration metadata points outside the recording folder.");
  }
  return resolved;
}

async function writeTranscript(file: string, transcript: NarrationTranscript): Promise<void> {
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(temp, JSON.stringify(transcript, null, 2));
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

async function removePartialDownloads(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await removePartialDownloads(file);
      } else if (/\.tmp\.\d+\./.test(entry.name)) {
        await rm(file, { force: true });
      }
    }),
  );
}

export class NarrationManager {
  private current: NarrationStatus = {
    engine: "local",
    model: "missing",
    phase: "idle",
    progress: null,
    loadedBytes: null,
    totalBytes: null,
    activeSessionId: null,
    error: null,
  };
  private queue: Promise<void> = Promise.resolve();
  private downloadTask: Promise<NarrationActionResult> | null = null;
  private readonly sessionTasks = new Map<string, Promise<NarrationActionResult>>();
  private lastProgress = -1;

  constructor(private readonly emitStatus: (status: NarrationStatus) => void) {}

  initialize(): void {
    const ready = isNarrationModelCached();
    this.update({
      model: ready ? "ready" : "missing",
      phase: "idle",
      error: null,
    });
    if (ready) void this.cleanupLegacyModel();
  }

  /**
   * With the AWS backend, speech-to-text runs on the organization's SageMaker
   * endpoint, so there is no local model to download or load.
   */
  status(): NarrationStatus {
    if (this.engine() === "aws") {
      return { ...this.current, engine: "aws", model: "ready", progress: null, loadedBytes: null, totalBytes: null };
    }
    return { ...this.current, engine: "local" };
  }

  /** Re-announce the status after the AI backend changed. */
  refresh(): void {
    this.emitStatus(this.status());
  }

  isBusyWith(sessionId: string): boolean {
    return this.sessionTasks.has(sessionId);
  }

  downloadModel(): Promise<NarrationActionResult> {
    if (this.engine() === "aws" || this.current.model === "ready") {
      return Promise.resolve({ ok: true, outcome: "ready" });
    }
    if (this.downloadTask) return this.downloadTask;
    const task = this.enqueue(async () => {
      try {
        await this.loadModel(true, null);
        return { ok: true, outcome: "ready" } satisfies NarrationActionResult;
      } catch (err) {
        const error = message(err);
        this.update({
          model: isNarrationModelCached() ? "ready" : "error",
          phase: "idle",
          activeSessionId: null,
          error,
        });
        return { ok: false, error } satisfies NarrationActionResult;
      }
    });
    this.downloadTask = task;
    void task.finally(() => {
      if (this.downloadTask === task) this.downloadTask = null;
    });
    return task;
  }

  transcribeSession(sessionId: string): Promise<NarrationActionResult> {
    if (!isValidSessionId(sessionId)) {
      return Promise.resolve({ ok: false, error: "Unknown session." });
    }
    const existing = this.sessionTasks.get(sessionId);
    if (existing) return existing;
    const task = this.enqueue(() => this.runTranscription(sessionId, true));
    this.sessionTasks.set(sessionId, task);
    void task.finally(() => {
      if (this.sessionTasks.get(sessionId) === task) this.sessionTasks.delete(sessionId);
    });
    return task;
  }

  /**
   * Ensure a session's voice narration is transcribed before an analysis runs, so
   * `describer.analyze` never silently proceeds without the user's own words.
   * Downloads the voice model on first use. Best-effort: on failure it resolves
   * with the error (already surfaced via the narration status) instead of
   * throwing, so the caller can still analyze without voice and the audio stays
   * saved. A session with no audio, or one already transcribed, is a fast no-op
   * that never touches the transcription queue.
   */
  async ensureTranscribedForAnalysis(sessionId: string): Promise<NarrationActionResult> {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    const dir = sessionDir(sessionId);
    const hasAudio = existsSync(path.join(dir, "audio.json"));
    const hasTranscript = readTranscript(path.join(dir, NARRATION_FILE)) != null;
    if (!shouldTranscribeBeforeAnalyze(hasAudio, hasTranscript)) {
      return hasTranscript ? { ok: true, outcome: "already-transcribed" } : { ok: true };
    }
    const result = await this.transcribeSessionWithDownload(sessionId, true);
    if (!result.ok) {
      log.warn(
        `pre-analysis transcription failed for ${sessionId}:`,
        result.error ?? result.outcome,
      );
    }
    return result;
  }

  async transcribeIfCached(dir: string): Promise<void> {
    // Remote speech-to-text uploads the user's voice, so it waits until they
    // choose Analyze or Transcribe instead of running when a recording stops.
    if (this.engine() === "aws") return;
    if (!isNarrationModelCached()) return;
    const id = path.basename(dir);
    if (!isValidSessionId(id)) return;
    const result = await this.transcribeSessionWithDownload(id, false);
    if (!result.ok && result.outcome !== "model-missing") {
      log.warn("cached narration transcription failed:", result.error);
    }
  }

  private transcribeSessionWithDownload(
    sessionId: string,
    allowDownload: boolean,
  ): Promise<NarrationActionResult> {
    const existing = this.sessionTasks.get(sessionId);
    if (existing) return existing;
    const task = this.enqueue(() => this.runTranscription(sessionId, allowDownload));
    this.sessionTasks.set(sessionId, task);
    void task.finally(() => {
      if (this.sessionTasks.get(sessionId) === task) this.sessionTasks.delete(sessionId);
    });
    return task;
  }

  private engine(): NarrationEngine {
    return resolveAiConfig().provider === "aws" ? "aws" : "local";
  }

  private remotePipeline() {
    const { proxyUrl, proxyToken } = resolveAiConfig();
    if (!proxyUrl || !proxyToken) throw new Error(AWS_PROXY_NOT_CONFIGURED_ERROR);
    return createRemoteAsrPipeline(new ProxyApi(proxyUrl, proxyToken));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async runTranscription(
    sessionId: string,
    allowDownload: boolean,
  ): Promise<NarrationActionResult> {
    const dir = sessionDir(sessionId);
    const narrationFile = path.join(dir, NARRATION_FILE);
    if (readTranscript(narrationFile)) {
      return { ok: true, outcome: "already-transcribed" };
    }
    await rm(narrationFile, { force: true });

    const audioJson = path.join(dir, "audio.json");
    if (!existsSync(audioJson)) return { ok: false, error: "This recording has no saved narration." };

    let meta: SessionMeta;
    let audioSources: AudioSource[];
    let narrationLanguage: NarrationLanguage;
    try {
      meta = readJson<SessionMeta>(path.join(dir, "session.json"));
      const audioMetadata = readJson<unknown>(audioJson);
      audioSources = readAudioSources(audioMetadata);
      narrationLanguage = readAudioNarrationLanguage(audioMetadata);
    } catch (err) {
      return { ok: false, error: `Could not read narration metadata: ${message(err)}` };
    }

    if (audioSources.length === 0) {
      return { ok: false, error: "This recording has no saved narration." };
    }
    let sourceFiles: Array<AudioSource & { audioPath: string }>;
    try {
      sourceFiles = audioSources.map((source) => ({
        ...source,
        audioPath: resolveSessionFile(dir, source.file),
      }));
    } catch (err) {
      return { ok: false, error: message(err) };
    }
    if (sourceFiles.some((source) => !existsSync(source.audioPath))) {
      return { ok: false, error: "One or more saved narration segments are missing." };
    }

    const remote = this.engine() === "aws";
    if (!remote && !allowDownload && !isNarrationModelCached()) {
      this.update({
        model: "missing",
        phase: "idle",
        activeSessionId: null,
        error: null,
      });
      return { ok: false, outcome: "model-missing" };
    }

    try {
      const pipe = remote ? this.remotePipeline() : await this.loadModel(allowDownload, sessionId);
      this.update({
        model: "ready",
        phase: "transcribing",
        progress: null,
        loadedBytes: null,
        totalBytes: null,
        activeSessionId: sessionId,
        error: null,
      });
      const transcript: NarrationTranscript = {
        model: "",
        language: narrationLanguage,
        segments: [],
      };
      for (const source of sourceFiles) {
        const segmentTranscript = await transcribeNarration(
          source.audioPath,
          source.startEpoch - meta.startedAt,
          source.durationMs,
          narrationLanguage,
          pipe,
          remote ? REMOTE_NARRATION_MODEL_ID : undefined,
        );
        transcript.model ||= segmentTranscript.model;
        transcript.segments.push(...segmentTranscript.segments);
      }
      transcript.segments.sort((a, b) => a.atMs - b.atMs);
      await writeTranscript(narrationFile, transcript);
      log.info(`transcribed ${sessionId}: ${transcript.segments.length} segment(s)`);
      this.update({
        model: "ready",
        phase: "idle",
        activeSessionId: null,
        error: null,
      });
      return {
        ok: true,
        outcome: transcript.segments.length > 0 ? "transcribed" : "no-speech",
      };
    } catch (err) {
      const error = message(err);
      const modelReady = isNarrationModelCached();
      this.update({
        model: modelReady ? "ready" : allowDownload ? "error" : "missing",
        phase: "idle",
        activeSessionId: sessionId,
        error,
      });
      log.warn(`transcription failed for ${sessionId}:`, error);
      return { ok: false, error };
    }
  }

  private async loadModel(
    allowDownload: boolean,
    activeSessionId: string | null,
  ): ReturnType<typeof getAsrPipeline> {
    const cached = isNarrationModelCached();
    const downloading = allowDownload && !cached;
    if (!allowDownload && !cached) throw new Error("Voice model is not downloaded.");
    if (downloading) await removePartialDownloads(narrationModelCacheDir());

    this.lastProgress = -1;
    this.update({
      model: cached ? "ready" : "downloading",
      phase: cached ? "loading" : "downloading",
      progress: cached ? null : 0,
      loadedBytes: cached ? null : 0,
      totalBytes: null,
      activeSessionId,
      error: null,
    });

    const pipe = await getAsrPipeline({
      allowDownload,
      onProgress: (progress) =>
        this.onModelProgress(progress, activeSessionId, downloading),
    });
    await this.cleanupLegacyModel();
    this.update({
      model: "ready",
      phase: "idle",
      progress: null,
      loadedBytes: null,
      totalBytes: null,
      activeSessionId: null,
      error: null,
    });
    return pipe;
  }

  private async cleanupLegacyModel(): Promise<void> {
    try {
      await removeLegacyNarrationModelCache();
    } catch (error) {
      log.warn("could not remove the superseded English narration model:", message(error));
    }
  }

  private onModelProgress(
    progress: ModelLoadProgress,
    activeSessionId: string | null,
    downloading: boolean,
  ): void {
    if (!downloading || progress.status !== "progress_total") return;
    const percent = Math.max(0, Math.min(100, Math.floor(progress.progress ?? 0)));
    if (percent === this.lastProgress) return;
    this.lastProgress = percent;
    this.update({
      model: "downloading",
      phase: "downloading",
      progress: percent,
      loadedBytes: progress.loaded ?? null,
      totalBytes: progress.total ?? null,
      activeSessionId,
      error: null,
    });
  }

  private update(patch: Partial<NarrationStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emitStatus(this.status());
  }
}
