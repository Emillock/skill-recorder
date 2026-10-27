import { createHash } from "node:crypto";

import { GetItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { HttpError } from "./http.ts";

/**
 * Per-user access tokens. Only a SHA-256 hash of each token is stored; the
 * token itself is shown once when it's issued (scripts/tokens.mjs).
 */

export const TOKEN_PATTERN = /^srp_[A-Za-z0-9_-]{32,128}$/;

export interface TokenRecord {
  user: string;
  disabled?: boolean;
}

export interface TokenStore {
  find(tokenHash: string): Promise<TokenRecord | null>;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The token from `Authorization: Bearer …` (what the Anthropic SDK sends) or `x-api-key`. */
export function presentedToken(headers: Record<string, string>): string | null {
  const auth = headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  return match?.[1] ?? headers["x-api-key"] ?? null;
}

/** Resolve the request's user, or throw 401. */
export async function authenticate(headers: Record<string, string>, store: TokenStore): Promise<string> {
  const token = presentedToken(headers);
  if (!token || !TOKEN_PATTERN.test(token)) {
    throw new HttpError(401, "authentication_error", "Missing or malformed access token.");
  }
  const record = await store.find(hashToken(token));
  if (!record || record.disabled) {
    throw new HttpError(401, "authentication_error", "This access token isn't valid. Ask your administrator for a new one.");
  }
  return record.user;
}

export class DynamoTokenStore implements TokenStore {
  private readonly client: DynamoDBClient;
  private readonly table: string;

  constructor(client: DynamoDBClient, table: string) {
    this.client = client;
    this.table = table;
  }

  async find(tokenHash: string): Promise<TokenRecord | null> {
    const result = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { tokenHash: { S: tokenHash } } }),
    );
    const item = result.Item;
    const user = item?.user?.S;
    if (!user) return null;
    return { user, disabled: item?.disabled?.BOOL === true };
  }
}

/** Caches lookups briefly so a conversation's requests don't each hit DynamoDB.
 *  A revoked token stops working within `ttlMs`. */
export class CachedTokenStore implements TokenStore {
  private readonly inner: TokenStore;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { record: TokenRecord | null; expires: number }>();

  constructor(inner: TokenStore, ttlMs = 60_000, now: () => number = Date.now) {
    this.inner = inner;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async find(tokenHash: string): Promise<TokenRecord | null> {
    const hit = this.cache.get(tokenHash);
    if (hit && hit.expires > this.now()) return hit.record;
    const record = await this.inner.find(tokenHash);
    if (this.cache.size > 1_000) this.cache.clear();
    this.cache.set(tokenHash, { record, expires: this.now() + this.ttlMs });
    return record;
  }
}
