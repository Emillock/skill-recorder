import { authenticate, type TokenStore } from "./auth.ts";
import type { ProxyConfig } from "./config.ts";
import { errorMessage, errorResponse, HttpError, json, type ProxyRequest, type ProxyResponse } from "./http.ts";
import { handleImageUpload, type ImageStore } from "./images.ts";
import { handleMessages, type ModelGateway } from "./messages.ts";
import { handleTranscribe, type SpeechEndpoint } from "./transcribe.ts";

export interface Deps {
  config: ProxyConfig;
  tokens: TokenStore;
  images: ImageStore;
  models: ModelGateway;
  speech: SpeechEndpoint | null;
  /** One structured log line (no prompt or image content is ever logged). */
  log(entry: Record<string, unknown>): void;
}

/** Route one request. Every route requires a valid access token. */
export async function handleRequest(req: ProxyRequest, deps: Deps): Promise<ProxyResponse> {
  try {
    const user = await authenticate(req.headers, deps.tokens);
    const route = `${req.method.toUpperCase()} ${req.path.replace(/\/+$/, "")}`;
    switch (route) {
      case "GET /v1/health":
        return json(200, {
          ok: true,
          user,
          defaultModel: deps.config.defaultModel,
          allowedModels: deps.config.allowedModels,
          transcription: Boolean(deps.speech && deps.config.asrEndpointName),
        });
      case "POST /v1/messages":
        return await handleMessages(req, user, deps);
      case "POST /v1/uploads/images":
        return await handleImageUpload(req, user, deps.images);
      case "POST /v1/transcribe":
        return await handleTranscribe(req, user, deps);
      default:
        throw new HttpError(404, "not_found_error", `No route for ${route}.`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status >= 500) deps.log({ level: "error", path: req.path, status: err.status, message: err.message });
      return errorResponse(err.status, err.type, err.message);
    }
    deps.log({ level: "error", path: req.path, message: errorMessage(err) });
    return errorResponse(500, "api_error", "The Skill Recorder service hit an internal error.");
  }
}
