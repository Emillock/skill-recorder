import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AiConnectionResult, AiProvider, AiSettingsInput, AiSettingsStatus } from "../common/ipc";

/** Where analysis and skill building run: Claude on AWS, or GitHub Copilot. */
export function AiSettingsForm({ onSaved }: { onSaved?: () => void }) {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [provider, setProvider] = useState<AiProvider>("aws");
  const [proxyUrl, setProxyUrl] = useState("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ids = { url: useId(), token: useId(), model: useId() };

  useEffect(() => {
    let live = true;
    const apply = (next: AiSettingsStatus) => {
      if (!live) return;
      setStatus(next);
      setProvider(next.provider);
      setProxyUrl(next.proxyUrl);
      setModel(next.model);
    };
    void window.skillRecorder.aiSettings().then(apply);
    const unsubscribe = window.skillRecorder.onAiSettingsChanged(apply);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const input = (): AiSettingsInput => ({
    provider,
    proxyUrl,
    model,
    ...(token.trim() ? { token: token.trim() } : removeToken ? { token: "" } : {}),
  });

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const result = await window.skillRecorder.saveAiSettings(input());
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error ?? "Couldn't save AI settings." });
        return;
      }
      setStatus(result.status);
      setToken("");
      setRemoveToken(false);
      setMessage({ kind: "ok", text: "Saved. The next analysis or build uses these settings." });
      onSaved?.();
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const result: AiConnectionResult = await window.skillRecorder.testAiConnection(
        token.trim() ? input() : { provider, proxyUrl, model },
      );
      setMessage(
        result.ok
          ? {
              kind: "ok",
              text:
                `Connected${result.user ? ` as ${result.user}` : ""}. ` +
                (result.transcription ? "Speech-to-text is available." : "Speech-to-text isn't set up on this service."),
            }
          : { kind: "error", text: result.error ?? "Couldn't reach the service." },
      );
    } finally {
      setBusy(null);
    }
  };

  if (!status) return <p className="sheet-lead">Loading…</p>;

  const aws = provider === "aws";
  return (
    <div className="ai-settings">
      <fieldset className="ai-provider" disabled={busy !== null}>
        <legend className="sheet-block-title">Run analysis and skill building on</legend>
        <label>
          <input type="radio" name="ai-provider" checked={aws} onChange={() => setProvider("aws")} />
          <span>
            <strong>Claude on AWS</strong>
            <small>Your organization's Skill Recorder service (Amazon Bedrock). Voice narration is transcribed there too.</small>
          </span>
        </label>
        <label>
          <input type="radio" name="ai-provider" checked={!aws} onChange={() => setProvider("copilot")} />
          <span>
            <strong>GitHub Copilot</strong>
            <small>The bundled Copilot CLI with your GitHub account. Narration is transcribed on this computer.</small>
          </span>
        </label>
      </fieldset>

      {aws && (
        <div className="ai-fields">
          <label htmlFor={ids.url}>Service URL</label>
          <input
            id={ids.url}
            className="fb-input"
            type="url"
            placeholder="https://…lambda-url.<region>.on.aws"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
          />
          <label htmlFor={ids.token}>Access token</label>
          <input
            id={ids.token}
            className="fb-input"
            type="password"
            autoComplete="off"
            placeholder={status.hasToken && !removeToken ? "Saved — paste a new token to replace it" : "srp_…"}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setRemoveToken(false);
            }}
            disabled={busy !== null}
            spellCheck={false}
          />
          {status.hasToken && !token && (
            <button className="linky ai-remove-token" onClick={() => setRemoveToken((v) => !v)} disabled={busy !== null}>
              {removeToken ? "Keep the saved token" : "Remove the saved token"}
            </button>
          )}
          <label htmlFor={ids.model}>Model</label>
          <input
            id={ids.model}
            className="fb-input"
            placeholder={`${status.defaultModel} (default)`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
          />
          {!status.secureStorage && (
            <p className="sheet-caution">
              This computer can't encrypt saved secrets, so a token can't be saved here. Set
              SKILL_RECORDER_PROXY_TOKEN in the environment instead.
            </p>
          )}
        </div>
      )}

      {status.envOverrides.length > 0 && (
        <p className="sheet-note">Environment variables override these settings: {status.envOverrides.join(", ")}.</p>
      )}
      {message && (
        <p className={message.kind === "error" ? "sheet-caution" : "ai-ok"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <div className="sheet-actions">
        {aws && (
          <button className="ghost" onClick={() => void test()} disabled={busy !== null || !proxyUrl.trim()}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        )}
        <button className="record-cta" onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** The AI settings form in a modal sheet. */
export function AiSettingsSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      queueMicrotask(() => previousFocus?.focus());
    };
  }, []);

  return createPortal(
    <div className="sheet-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialog} className="sheet ai-settings-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-head">
          <h2 id={titleId}>AI settings</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <AiSettingsForm />
      </div>
    </div>,
    document.body,
  );
}
