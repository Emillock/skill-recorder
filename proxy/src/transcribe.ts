import { InvokeEndpointCommand, type SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";

import type { ProxyConfig } from "./config.ts";
import { contentType, errorMessage, HttpError, isObject, json, type ProxyRequest, type ProxyResponse } from "./http.ts";

/**
 * `POST /v1/transcribe?language=xx`: speech-to-text for one WAV clip on the
 * organization's SageMaker endpoint. The desktop sends 16 kHz mono clips of at
 * most a minute and gets back `{ text, chunks: [{ timestamp: [start, end], text }] }`,
 * the same shape as the on-device Whisper pipeline.
 */

/** About two minutes of 16 kHz 16-bit mono, under Lambda's 6 MB request limit once base64-encoded. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export interface SpeechEndpoint {
  invoke(input: { body: Uint8Array; contentType: string; customAttributes?: string }): Promise<Uint8Array>;
}

export interface Transcript {
  text: string;
  chunks: { timestamp: [number, number | null]; text: string }[];
}

export async function handleTranscribe(
  req: ProxyRequest,
  user: string,
  deps: { config: ProxyConfig; speech: SpeechEndpoint | null; log(entry: Record<string, unknown>): void },
): Promise<ProxyResponse> {
  if (!deps.speech || !deps.config.asrEndpointName) {
    throw new HttpError(501, "api_error", "Speech-to-text isn't set up on this Skill Recorder service.");
  }
  const language = req.query.get("language") ?? "en";
  if (!/^[a-z]{2,3}$/.test(language)) {
    throw new HttpError(400, "invalid_request_error", "language must be a Whisper language code such as en or de.");
  }
  if (!["audio/wav", "audio/x-wav", "audio/wave"].includes(contentType(req.headers))) {
    throw new HttpError(400, "invalid_request_error", "Send audio as audio/wav.");
  }
  const audio = req.body;
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new HttpError(413, "request_too_large", "Audio clips can be at most 4 MB; send shorter clips.");
  }
  if (audio.length < 44 || audio.subarray(0, 4).toString("latin1") !== "RIFF" || audio.subarray(8, 12).toString("latin1") !== "WAVE") {
    throw new HttpError(400, "invalid_request_error", "The audio isn't a WAV file.");
  }

  const request =
    deps.config.asrRequestFormat === "wav"
      ? { body: audio, contentType: "audio/wav", customAttributes: `language=${language}` }
      : {
          body: Buffer.from(JSON.stringify({ audio: audio.toString("base64"), language, return_timestamps: true })),
          contentType: "application/json",
        };
  let raw: Uint8Array;
  try {
    raw = await deps.speech.invoke(request);
  } catch (err) {
    throw speechError(err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    parsed = Buffer.from(raw).toString("utf8");
  }
  const transcript = normalizeTranscript(parsed);
  deps.log({ route: "transcribe", user, language, audioBytes: audio.length, chunks: transcript.chunks.length });
  return json(200, transcript);
}

/**
 * Accept the common Whisper serving shapes: the transformers pipeline's
 * `{ text, chunks: [{ timestamp: [s, e], text }] }`, OpenAI/faster-whisper's
 * `{ text, segments: [{ start, end, text }] }`, either wrapped in a one-item
 * array, or plain text (no timestamps).
 */
export function normalizeTranscript(raw: unknown): Transcript {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string") return { text: value, chunks: [] };
  if (!isObject(value)) {
    throw new HttpError(502, "api_error", "The speech-to-text endpoint returned an unexpected response.");
  }
  const chunks: Transcript["chunks"] = [];
  if (Array.isArray(value.chunks)) {
    for (const chunk of value.chunks) {
      if (!isObject(chunk) || typeof chunk.text !== "string" || !Array.isArray(chunk.timestamp)) continue;
      const [start, end] = chunk.timestamp;
      chunks.push({ text: chunk.text, timestamp: [Number(start) || 0, end == null ? null : Number(end)] });
    }
  } else if (Array.isArray(value.segments)) {
    for (const segment of value.segments) {
      if (!isObject(segment) || typeof segment.text !== "string" || typeof segment.start !== "number") continue;
      chunks.push({
        text: segment.text,
        timestamp: [segment.start, typeof segment.end === "number" ? segment.end : null],
      });
    }
  }
  const text = typeof value.text === "string" ? value.text : chunks.map((c) => c.text).join("");
  return { text, chunks };
}

function speechError(err: unknown): HttpError {
  const name = err instanceof Error ? err.name : "";
  const message = errorMessage(err);
  if (name === "ModelError") return new HttpError(502, "api_error", `The speech-to-text model failed: ${message}`);
  if (name === "ThrottlingException") return new HttpError(429, "rate_limit_error", "Speech-to-text is busy. Try again shortly.");
  if (name === "ServiceUnavailable" || name === "ModelNotReadyException") {
    return new HttpError(503, "overloaded_error", "The speech-to-text endpoint isn't ready. Try again shortly.");
  }
  if (name === "ValidationError") return new HttpError(500, "api_error", `The speech-to-text endpoint is misconfigured: ${message}`);
  return new HttpError(502, "api_error", `Speech-to-text failed: ${message}`);
}

export class SageMakerSpeechEndpoint implements SpeechEndpoint {
  private readonly client: SageMakerRuntimeClient;
  private readonly endpointName: string;

  constructor(client: SageMakerRuntimeClient, endpointName: string) {
    this.client = client;
    this.endpointName = endpointName;
  }

  async invoke(input: { body: Uint8Array; contentType: string; customAttributes?: string }): Promise<Uint8Array> {
    const result = await this.client.send(
      new InvokeEndpointCommand({
        EndpointName: this.endpointName,
        ContentType: input.contentType,
        Accept: "application/json",
        Body: input.body,
        ...(input.customAttributes ? { CustomAttributes: input.customAttributes } : {}),
      }),
    );
    return result.Body ?? new Uint8Array();
  }
}
