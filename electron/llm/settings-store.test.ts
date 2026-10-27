import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { resolveAiConfig, setStoredAiConfigSource } from "./config";
import { AiSettingsStore, validateProxyUrl, type TokenCipher } from "./settings-store";

function cipher(available = true): TokenCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`enc:${plain}`).toString("base64"),
    decrypt: (encoded) => {
      const text = Buffer.from(encoded, "base64").toString();
      if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
      return text.slice(4);
    },
  };
}

function fixture(t: TestContext, available = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ai-settings.json");
  return { file, store: new AiSettingsStore(file, cipher(available)) };
}

test("defaults to the AWS backend with nothing configured", (t) => {
  const { store } = fixture(t);
  store.load();
  const status = store.status({});
  assert.equal(status.provider, "aws");
  assert.equal(status.hasToken, false);
  assert.equal(status.proxyUrl, "");
});

test("saves settings with the token encrypted and reloads them", (t) => {
  const { file, store } = fixture(t);
  const result = store.save({
    provider: "aws",
    proxyUrl: "https://abc.lambda-url.us-east-1.on.aws/",
    model: "claude-sonnet-5-5",
    token: "srp_secret_value",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status.proxyUrl, "https://abc.lambda-url.us-east-1.on.aws");
  assert.equal(result.status.hasToken, true);
  assert.equal(readFileSync(file, "utf8").includes("srp_secret_value"), false);

  const reloaded = new AiSettingsStore(file, cipher());
  reloaded.load();
  assert.deepEqual(reloaded.stored(), {
    provider: "aws",
    proxyUrl: "https://abc.lambda-url.us-east-1.on.aws",
    proxyToken: "srp_secret_value",
    model: "claude-sonnet-5-5",
  });
});

test("an omitted token keeps the saved one and an empty token removes it", (t) => {
  const { store } = fixture(t);
  store.save({ provider: "aws", proxyUrl: "https://proxy.example", model: "", token: "srp_secret_value" });
  store.save({ provider: "copilot", proxyUrl: "https://proxy.example", model: "" });
  assert.equal(store.savedToken(), "srp_secret_value");
  store.save({ provider: "aws", proxyUrl: "https://proxy.example", model: "", token: "" });
  assert.equal(store.savedToken(), "");
  assert.equal(store.status({}).hasToken, false);
});

test("rejects unsafe URLs, malformed models and tokens, and tokens it can't encrypt", (t) => {
  const { store } = fixture(t);
  const base = { provider: "aws" as const, model: "" };
  assert.match(store.save({ ...base, proxyUrl: "http://proxy.example" }).error ?? "", /https/);
  assert.match(store.save({ ...base, proxyUrl: "https://u:p@proxy.example" }).error ?? "", /without credentials/);
  assert.match(store.save({ ...base, proxyUrl: "https://p.example", model: "Bad Model!" }).error ?? "", /model ID/);
  assert.match(store.save({ ...base, proxyUrl: "https://p.example", token: "short" }).error ?? "", /doesn't look right/);
  const plain = fixture(t, false).store;
  assert.match(
    plain.save({ ...base, proxyUrl: "https://p.example", token: "srp_secret_value" }).error ?? "",
    /SKILL_RECORDER_PROXY_TOKEN/,
  );
  assert.equal(validateProxyUrl("http://localhost:8787"), null);
});

test("an undecryptable saved token is dropped instead of failing startup", (t) => {
  const { file } = fixture(t);
  writeFileSync(file, JSON.stringify({ version: 1, provider: "aws", proxyUrl: "https://p.example", model: "", encryptedToken: "garbage" }));
  const store = new AiSettingsStore(file, cipher());
  store.load();
  assert.equal(store.savedToken(), "");
  assert.equal(store.status({}).proxyUrl, "https://p.example");
});

test("environment variables override saved settings", (t) => {
  const { store } = fixture(t);
  store.save({ provider: "copilot", proxyUrl: "https://saved.example", model: "", token: "srp_saved_token" });
  setStoredAiConfigSource(() => store.stored());
  t.after(() => setStoredAiConfigSource(() => ({})));
  assert.deepEqual(resolveAiConfig({}), {
    provider: "copilot",
    proxyUrl: "https://saved.example",
    proxyToken: "srp_saved_token",
    model: "",
  });
  assert.deepEqual(
    resolveAiConfig({
      SKILL_RECORDER_PROVIDER: "aws",
      SKILL_RECORDER_PROXY_URL: "https://env.example/",
      SKILL_RECORDER_PROXY_TOKEN: "srp_env_token",
      SKILL_RECORDER_MODEL: "claude-haiku-5-5",
    }),
    { provider: "aws", proxyUrl: "https://env.example", proxyToken: "srp_env_token", model: "claude-haiku-5-5" },
  );
  assert.deepEqual(store.status({ SKILL_RECORDER_PROXY_URL: "x" }).envOverrides, ["SKILL_RECORDER_PROXY_URL"]);
});
