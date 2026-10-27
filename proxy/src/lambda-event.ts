import type { ProxyRequest } from "./http.ts";

/** Lambda function URL event (payload format 2.0), the fields we use. */
export interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

export function toProxyRequest(event: FunctionUrlEvent): ProxyRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  return {
    method: event.requestContext?.http?.method ?? "GET",
    path: event.rawPath ?? "/",
    query: new URLSearchParams(event.rawQueryString ?? ""),
    headers,
    body: event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0),
  };
}
