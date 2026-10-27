import { detectSilence, type SilenceSpan } from "./audio-analysis";
import type { AsrPipeline } from "./whisper";

/**
 * Speech-to-text on the organization's SageMaker endpoint, reached through the
 * Skill Recorder service on AWS. Returns the same shape as the on-device
 * Whisper pipeline, so `transcribeNarration` filters and anchors it the same way.
 *
 * Narration is sent as 16 kHz mono 16-bit WAV in clips of at most a minute
 * (about 1.9 MB each), cut at pauses where possible so words aren't split. Each
 * clip's timestamps are shifted back onto the recording's audio clock.
 */

const SAMPLE_RATE = 16_000;
/** Longest clip sent in one request; keeps requests well under Lambda's payload limit. */
export const MAX_CLIP_SEC = 60;
/** Don't cut earlier than this when looking for a pause. */
const MIN_CLIP_SEC = 20;

/** The part of the proxy API this needs (a test seam). */
export interface RemoteTranscriber {
  transcribe(
    wav: Uint8Array<ArrayBuffer>,
    language: string,
  ): Promise<{ text: string; chunks: Array<{ timestamp: [number, number | null]; text: string }> }>;
}

export function createRemoteAsrPipeline(api: RemoteTranscriber): AsrPipeline {
  return async (audio, options) => {
    const language = options?.language ?? "en";
    const silences = detectSilence(audio, SAMPLE_RATE);
    const chunks: Array<{ timestamp: [number, number | null]; text: string }> = [];
    const texts: string[] = [];
    for (const [startSec, endSec] of clipBoundaries(audio.length / SAMPLE_RATE, silences)) {
      const clip = audio.subarray(Math.round(startSec * SAMPLE_RATE), Math.round(endSec * SAMPLE_RATE));
      if (clip.length === 0) continue;
      const result = await api.transcribe(encodeWav(clip, SAMPLE_RATE), language);
      if (result.text.trim()) texts.push(result.text.trim());
      if (result.chunks.length) {
        for (const chunk of result.chunks) {
          const [from, to] = chunk.timestamp;
          chunks.push({
            text: chunk.text,
            timestamp: [startSec + from, to == null ? null : Math.min(endSec, startSec + to)],
          });
        }
      } else if (result.text.trim()) {
        chunks.push({ text: result.text, timestamp: [startSec, endSec] });
      }
    }
    return { text: texts.join(" "), chunks };
  };
}

/**
 * Split `[0, durationSec]` into clips no longer than {@link MAX_CLIP_SEC}, cutting
 * in the middle of the last pause that leaves at least {@link MIN_CLIP_SEC}.
 */
export function clipBoundaries(
  durationSec: number,
  silences: SilenceSpan[],
  maxClipSec = MAX_CLIP_SEC,
): Array<[number, number]> {
  const clips: Array<[number, number]> = [];
  let start = 0;
  while (durationSec - start > maxClipSec) {
    const latest = start + maxClipSec;
    const earliest = start + Math.min(MIN_CLIP_SEC, maxClipSec);
    let cut = latest;
    for (const span of silences) {
      const middle = (span.start + span.end) / 2;
      if (middle > earliest && middle <= latest) cut = middle;
    }
    clips.push([start, cut]);
    start = cut;
  }
  if (durationSec > start) clips.push([start, durationSec]);
  return clips;
}

/** 16-bit PCM WAV, mono. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}
