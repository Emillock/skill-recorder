/** Transport-neutral request/response types, so handlers are testable without Lambda. */

export interface ProxyRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  body: Buffer;
}

export interface BufferedResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface StreamingResponse {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<string>;
}

export type ProxyResponse = BufferedResponse | StreamingResponse;

/** Error types in the Anthropic API's error format, so the desktop SDK raises typed errors. */
export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export class HttpError extends Error {
  readonly status: number;
  readonly type: ErrorType;

  constructor(status: number, type: ErrorType, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function json(status: number, body: unknown): BufferedResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function errorResponse(status: number, type: ErrorType, message: string): BufferedResponse {
  return json(status, { type: "error", error: { type, message } });
}

export function errorTypeFor(status: number): ErrorType {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529 || status === 503) return "overloaded_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_request_error", "The request body is not valid JSON.");
  }
}

/** The media type without parameters, lower-case. */
export function contentType(headers: Record<string, string>): string {
  return (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
