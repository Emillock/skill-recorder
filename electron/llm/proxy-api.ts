import { createHash } from "node:crypto";

import { AWS_PROXY_TOKEN_REJECTED_ERROR } from "../../common/ipc";

/**
 * Client for the non-Messages routes of the Skill Recorder service on AWS (the
 * proxy in `proxy/`). The Messages route is called through the Anthropic SDK.
 */

export interface ProxyHealth {
  ok: boolean;
  /** Name the access token was issued to. */
  user: string;
  defaultModel: string;
  allowedModels: string[];
  /** A SageMaker speech-to-text endpoint is configured. */
  transcription: boolean;
}

/** Speech-to-text output, in the shape the transformers.js ASR pipeline returns. */
export interface ProxyTranscript {
  text: string;
  chunks: { timestamp: [number, number | null]; text: string }[];
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class ProxyApi {
  /** sha256 of uploaded image data → file id, so frames re-sent later aren't re-uploaded. */
  private readonly uploads = new Map<string, Promise<string>>();

  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async health(signal?: AbortSignal): Promise<ProxyHealth> {
    const response = await this.request("/v1/health", { method: "GET", signal });
    const body = (await response.json()) as Partial<ProxyHealth>;
    return {
      ok: body.ok === true,
      user: typeof body.user === "string" ? body.user : "",
      defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : "",
      allowedModels: Array.isArray(body.allowedModels)
        ? body.allowedModels.filter((m): m is string => typeof m === "string")
        : [],
      transcription: body.transcription === true,
    };
  }

  /** Store one image on the service and return the file id to reference it by. */
  uploadImage(base64: string, mimeType: string, signal?: AbortSignal): Promise<string> {
    const key = createHash("sha256").update(mimeType).update("\0").update(base64).digest("hex");
    const cached = this.uploads.get(key);
    if (cached) return cached;
    const upload = (async () => {
      const response = await this.request("/v1/uploads/images", {
        method: "POST",
        headers: { "content-type": mimeType },
        body: Buffer.from(base64, "base64"),
        signal,
      });
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id) {
        throw new Error("The Skill Recorder service did not return an image id.");
      }
      return body.id;
    })();
    this.uploads.set(key, upload);
    upload.catch(() => this.uploads.delete(key));
    return upload;
  }

  /** Transcribe one 16 kHz mono WAV clip. */
  async transcribe(wav: Uint8Array<ArrayBuffer>, language: string, signal?: AbortSignal): Promise<ProxyTranscript> {
    const response = await this.request(
      `/v1/transcribe?language=${encodeURIComponent(language)}`,
      { method: "POST", headers: { "content-type": "audio/wav" }, body: wav, signal },
    );
    const body = (await response.json()) as Partial<ProxyTranscript>;
    const chunks = Array.isArray(body.chunks) ? body.chunks : [];
    return {
      text: typeof body.text === "string" ? body.text : "",
      chunks: chunks
        .filter((c) => c && typeof c.text === "string" && Array.isArray(c.timestamp))
        .map((c) => ({
          text: c.text,
          timestamp: [
            Number(c.timestamp[0]) || 0,
            c.timestamp[1] == null ? null : Number(c.timestamp[1]),
          ],
        })),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new Error(`Can't reach the Skill Recorder service at ${this.baseUrl}: ${msg(err)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(AWS_PROXY_TOKEN_REJECTED_ERROR);
    }
    if (!response.ok) {
      throw new Error(`The Skill Recorder service returned ${response.status}: ${await errorMessage(response)}`);
    }
    return response;
  }
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {}
  return text.slice(0, 300) || response.statusText || "no details";
}
