import type { AiConnectionResult } from "../../common/ipc";
import { normalizeProxyUrl } from "./config";
import { ProxyApi } from "./proxy-api";
import { validateProxyUrl } from "./settings-store";

const TIMEOUT_MS = 15_000;

/** Ask the Skill Recorder service on AWS who the token belongs to and what it offers. */
export async function testAwsConnection(
  proxyUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AiConnectionResult> {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return { ok: false, error: "Enter the service URL first." };
  const urlError = validateProxyUrl(url);
  if (urlError) return { ok: false, error: urlError };
  if (!token) return { ok: false, error: "Enter your access token first." };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const health = await new ProxyApi(url, token, fetchImpl).health(signal);
    if (!health.ok) return { ok: false, error: "The service answered but reported a problem." };
    return {
      ok: true,
      user: health.user,
      defaultModel: health.defaultModel,
      allowedModels: health.allowedModels,
      transcription: health.transcription,
    };
  } catch (err) {
    if (signal.aborted) {
      return { ok: false, error: `The service at ${url} didn't answer within ${TIMEOUT_MS / 1000} seconds.` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
