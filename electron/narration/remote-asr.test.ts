import assert from "node:assert/strict";
import test from "node:test";

import { clipBoundaries, createRemoteAsrPipeline, encodeWav, MAX_CLIP_SEC } from "./remote-asr";

test("WAV encoding writes a 16 kHz mono 16-bit PCM header and clamps samples", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
  const view = new DataView(wav.buffer);
  const text = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length));
  assert.equal(wav.length, 44 + 8);
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true)),
    [0, 32767, -32768, 32767],
  );
});

test("long narration is cut in the middle of the last pause before the clip limit", () => {
  assert.deepEqual(clipBoundaries(45, []), [[0, 45]]);
  assert.deepEqual(
    clipBoundaries(150, [
      { start: 10, end: 11 },
      { start: 50, end: 52 },
      { start: 70, end: 70.5 },
    ]),
    [[0, 51], [51, 111], [111, 150]],
  );
  // No pause in range: hard cut at the limit.
  assert.deepEqual(clipBoundaries(130, []), [[0, MAX_CLIP_SEC], [MAX_CLIP_SEC, 120], [120, 130]]);
});

test("the remote pipeline sends each clip with the language and shifts timestamps back", async () => {
  const calls: Array<{ bytes: number; language: string }> = [];
  const pipe = createRemoteAsrPipeline({
    transcribe: async (wav, language) => {
      calls.push({ bytes: wav.length, language });
      return calls.length === 1
        ? { text: " first part", chunks: [{ timestamp: [1, 4], text: " first part" }] }
        : { text: " second part", chunks: [] };
    },
  });
  // 70 s of constant tone: no pauses, so a hard cut at 60 s.
  const audio = new Float32Array(70 * 16_000).fill(0.5);
  const result = await pipe(audio, { language: "de", return_timestamps: true });
  assert.deepEqual(calls, [
    { bytes: 44 + 60 * 16_000 * 2, language: "de" },
    { bytes: 44 + 10 * 16_000 * 2, language: "de" },
  ]);
  assert.equal(result.text, "first part second part");
  assert.deepEqual(result.chunks, [
    { text: " first part", timestamp: [1, 4] },
    { text: " second part", timestamp: [60, 70] },
  ]);
});
