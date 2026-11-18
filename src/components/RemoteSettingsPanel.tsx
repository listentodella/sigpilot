import { Copy, Globe, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauriRuntime } from "../lib/api";
import {
  configureRemote,
  readRemoteSetup,
  revokeRemoteClient,
  type RemoteSettings,
  type RemoteSetup,
} from "../lib/remote";

export function RemoteSettingsPanel() {
  const { t } = useTranslation("remote");
  const [setup, setSetup] = useState<RemoteSetup | null>(null);
  const [draft, setDraft] = useState<RemoteSettings | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState("");
  const desktop = isTauriRuntime();
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const refresh = async () => {
      try {
        const v = await readRemoteSetup();
        if (active) {
          setSetup(v);
          setDraft((old) => old ?? v.status.settings);
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [desktop]);
  const change = (patch: Partial<RemoteSettings>) =>
    setDraft((old) => (old ? { ...old, ...patch } : old));
  async function apply(enabled: boolean) {
    if (!draft) return;
    setBusy(true);
    setError("");
    setCopied("");
    try {
      await configureRemote(enabled, draft);
      setSetup(await readRemoteSetup());
    } catch (e) {
      setError(String(e));
      try {
        setSetup(await readRemoteSetup());
      } catch {
        /* Retain error */
      }
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string, kind: string) {
    try {
      await writeText(value);
      setCopied(kind);
    } catch (e) {
      setError(String(e));
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await revokeRemoteClient(id);
      setSetup(await readRemoteSetup());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mcpPanel remoteSettings">
      <header className="mcpIntro">
        <Globe size={21} />
        <div>
          <h3>{t("title")}</h3>
          <p>{t("description")}</p>
        </div>
      </header>
      {!desktop && <p className="mcpNotice">{t("desktopRequired")}</p>}
      {draft && (
        <>
          <section className="mcpSetupCard">
            <h4 className="mcpStepHeading">
              <span>1</span>
              {t("network")}
            </h4>
            <label className="mcpPermission">
              <input
                type="checkbox"
                checked={draft.listen_on_lan}
                disabled={busy}
                onChange={(e) =>
                  change({
                    listen_on_lan: e.target.checked,
                    public_url: e.target.checked
                      ? (setup?.suggested_lan_url ?? draft.public_url)
                      : `http://127.0.0.1:${draft.port}`,
                  })
                }
              />
              <span>
                {t("lan")}
                <small>{t("lanHint")}</small>
              </span>
            </label>
            <label className="mcpFieldLabel">
              {t("url")}
              <input
                className="remoteSettingInput"
                value={draft.public_url}
                disabled={busy}
                onChange={(e) => change({ public_url: e.target.value })}
              />
            </label>
            <p className="mcpHint">{t("urlHint")}</p>
            <label className="mcpPort">
              {t("port")}
              <input
                type="number"
                min={1024}
                max={65535}
                value={draft.port}
                disabled={busy}
                onChange={(e) => {
                  const port = Number(e.target.value);
                  let url = draft.public_url;
                  try {
                    const parsed = new URL(url);
                    parsed.port = String(port);
                    url = parsed.origin;
                  } catch {
                    /* Edited URL */
                  }
                  change({ port, public_url: url });
                }}
              />
            </label>
          </section>
          <section className="mcpSetupCard">
            <h4 className="mcpStepHeading">
              <span>2</span>
              {t("permissions")}
            </h4>
            <label className="mcpPermission">
              <input
                type="checkbox"
                checked={draft.can_edit}
                disabled={busy}
                onChange={(e) => change({ can_edit: e.target.checked })}
              />
              <span>
                {t("allowEdit")}
                <small>{t("sharedHint")}</small>
              </span>
            </label>
            <label className="mcpPermission">
              <input
                type="checkbox"
                checked={draft.can_capture}
                disabled={busy}
                onChange={(e) => change({ can_capture: e.target.checked })}
              />
              <span>
                {t("allowCapture")}
                <small>{t("captureHint")}</small>
              </span>
            </label>
            <div className="mcpServiceRow">
              <div
                className={`mcpServiceStatus ${setup?.status.enabled ? "enabled" : ""}`}
              >
                <i />
                {t(setup?.status.enabled ? "enabled" : "disabled")}
              </div>
              <button
                className="mcpPrimary"
                disabled={
                  busy ||
                  !Number.isInteger(draft.port) ||
                  draft.port < 1024 ||
                  draft.port > 65535
                }
                onClick={() => void apply(true)}
              >
                {t(setup?.status.enabled ? "apply" : "enable")}
              </button>
              {setup?.status.enabled && (
                <button disabled={busy} onClick={() => void apply(false)}>
                  {t("disable")}
                </button>
              )}
            </div>
            <p className="mcpHint">{t("restartHint")}</p>
          </section>
          <section className="mcpSetupCard">
            <h4 className="mcpStepHeading">
              <span>3</span>
              {t("connect")}
            </h4>
            <p className="mcpHint">{t("connectHint")}</p>
            {setup?.status.enabled && (
              <>
                <div className="mcpEndpoint">
                  <code>{setup.status.settings.public_url}</code>
                  <button
                    onClick={() =>
                      void copy(setup.status.settings.public_url, "url")
                    }
                    aria-label={t("copyUrl")}
                  >
                    {copied === "url" ? (
                      <Check size={13} />
                    ) : (
                      <Copy size={13} />
                    )}
                  </button>
                </div>
                <label className="mcpFieldLabel">{t("code")}</label>
                <textarea
                  className="mcpConfig"
                  rows={3}
                  readOnly
                  value={setup.status.access_code ?? ""}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={() =>
                    void copy(setup.status.access_code ?? "", "code")
                  }
                >
                  <Copy size={13} />
                  {t(copied === "code" ? "copied" : "copyCode")}
                </button>
              </>
            )}
            <p className="mcpHint">{t("authorizationHint")}</p>
          </section>
          <section className="mcpSetupCard">
            <h4>{t("clients")}</h4>
            {!setup?.status.clients.length && (
              <p className="mcpHint">{t("noClients")}</p>
            )}
            {setup?.status.clients.map((client) => (
              <div className="mcpAuthorizedClient" key={client.id}>
                <span>{client.name}</span>
                <button disabled={busy} onClick={() => void revoke(client.id)}>
                  {t("revoke")}
                </button>
              </div>
            ))}
          </section>
        </>
      )}
      {error && (
        <p className="mcpError" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
