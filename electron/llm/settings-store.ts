import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AiProvider, AiSettingsInput, AiSettingsResult, AiSettingsStatus } from "../../common/ipc";
import { createLogger } from "../logger";
import {
  aiEnvOverrides,
  DEFAULT_AWS_MODEL,
  DEFAULT_PROVIDER,
  normalizeProxyUrl,
  parseProvider,
  type StoredAiConfig,
} from "./config";

const log = createLogger("AiSettings");

export const AI_SETTINGS_FILE = "ai-settings.json";

/** Encrypts the access token at rest (Electron `safeStorage` in the app). */
export interface TokenCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

interface SavedSettings {
  version: 1;
  provider: AiProvider;
  proxyUrl: string;
  model: string;
  /** Base64 of the OS-encrypted token, or null when none is saved. */
  encryptedToken: string | null;
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,80}$/;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The user's AI backend choice, persisted in the app's user-data folder. The
 * proxy access token is encrypted with the OS keychain and only decrypted in
 * the main process; the renderer only ever learns whether one is saved.
 */
export class AiSettingsStore {
  private saved: SavedSettings = {
    version: 1,
    provider: DEFAULT_PROVIDER,
    proxyUrl: "",
    model: "",
    encryptedToken: null,
  };
  private token = "";

  constructor(
    private readonly file: string,
    private readonly cipher: TokenCipher,
  ) {}

  load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SavedSettings>;
      this.saved = {
        version: 1,
        provider: parseProvider(raw.provider) ?? DEFAULT_PROVIDER,
        proxyUrl: typeof raw.proxyUrl === "string" ? normalizeProxyUrl(raw.proxyUrl) : "",
        model: typeof raw.model === "string" && MODEL_ID.test(raw.model) ? raw.model : "",
        encryptedToken: typeof raw.encryptedToken === "string" ? raw.encryptedToken : null,
      };
    } catch (err) {
      log.warn("saved AI settings could not be read:", msg(err));
      return;
    }
    if (this.saved.encryptedToken) {
      try {
        this.token = this.cipher.decrypt(this.saved.encryptedToken);
      } catch (err) {
        // The keychain entry changed (new OS user, reset keychain): ask for the token again.
        log.warn("saved access token could not be decrypted:", msg(err));
        this.token = "";
      }
    }
  }

  /** What runtimes see (environment variables still override these). */
  stored(): StoredAiConfig {
    return {
      provider: this.saved.provider,
      proxyUrl: this.saved.proxyUrl,
      proxyToken: this.token,
      model: this.saved.model,
    };
  }

  /** The decrypted saved token, or empty when none is saved. */
  savedToken(): string {
    return this.token;
  }

  status(env: NodeJS.ProcessEnv = process.env): AiSettingsStatus {
    return {
      provider: this.saved.provider,
      activeProvider: parseProvider(env.SKILL_RECORDER_PROVIDER) ?? this.saved.provider,
      proxyUrl: this.saved.proxyUrl,
      model: this.saved.model,
      defaultModel: DEFAULT_AWS_MODEL,
      hasToken: Boolean(this.token || env.SKILL_RECORDER_PROXY_TOKEN),
      secureStorage: this.cipher.available(),
      envOverrides: aiEnvOverrides(env),
    };
  }

  save(input: AiSettingsInput): AiSettingsResult {
    const fail = (error: string): AiSettingsResult => ({ ok: false, status: this.status(), error });
    const provider = parseProvider(input?.provider);
    if (!provider) return fail("Choose an AI backend.");
    const proxyUrl = normalizeProxyUrl(typeof input.proxyUrl === "string" ? input.proxyUrl : "");
    const urlError = validateProxyUrl(proxyUrl);
    if (urlError) return fail(urlError);
    const model = typeof input.model === "string" ? input.model.trim() : "";
    if (model && !MODEL_ID.test(model)) return fail("Enter a Claude model ID such as claude-opus-5-5.");

    let token = this.token;
    let encryptedToken = this.saved.encryptedToken;
    if (typeof input.token === "string") {
      token = input.token.trim();
      if (!token) {
        encryptedToken = null;
      } else {
        if (token.length < 8 || token.length > 4096 || /\s/.test(token)) {
          return fail("That access token doesn't look right. Paste the whole token you were given.");
        }
        if (!this.cipher.available()) {
          return fail(
            "This computer can't encrypt saved secrets, so the token can't be stored. " +
              "Set SKILL_RECORDER_PROXY_TOKEN in the environment instead.",
          );
        }
        try {
          encryptedToken = this.cipher.encrypt(token);
        } catch (err) {
          return fail(`The access token couldn't be encrypted: ${msg(err)}`);
        }
      }
    }

    const next: SavedSettings = { version: 1, provider, proxyUrl, model, encryptedToken };
    try {
      writeAtomically(this.file, JSON.stringify(next, null, 2));
    } catch (err) {
      return fail(`AI settings couldn't be saved: ${msg(err)}`);
    }
    this.saved = next;
    this.token = encryptedToken ? token : "";
    return { ok: true, status: this.status() };
  }
}

/** Only HTTPS, except a local service during development. Empty is allowed (not set up yet). */
export function validateProxyUrl(url: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter the full service URL, starting with https://.";
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return "The service URL must start with https://.";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return "Enter only the service URL, without credentials or query parameters.";
  }
  return null;
}

function writeAtomically(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
