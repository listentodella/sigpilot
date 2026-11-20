import { Check, Copy, ExternalLink, PlugZap, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauriRuntime } from "../lib/api";
import { checkMcpConnection, configureMcp, openMcpClient, readMcpSetupInfo, readMcpAuthorization, decideMcpAuthorization, revokeMcpAuthorization, type McpAuthorizationStatus, type McpSetupInfo, type McpConnectionCheck } from "../lib/workbench";

const clients: Record<string, string> = { codex: "Codex", claude_code: "Claude Code", cursor: "Cursor", generic: "MCP" };

export function McpSettingsPanel() {
  const { t } = useTranslation("advanced");
  const [setup, setSetup] = useState<McpSetupInfo | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canCapture, setCanCapture] = useState(false);
  const [client, setClient] = useState("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [installOpened, setInstallOpened] = useState(false);
  const [check, setCheck] = useState<McpConnectionCheck | null>(null);
  const [authorization,setAuthorization]=useState<McpAuthorizationStatus>({pending:[],clients:[]});
  const [port,setPort]=useState("");
  const desktop = isTauriRuntime();
  const config = setup?.configurations.find((c) => c.id === client);
  const ready = Boolean(desktop && setup?.supported && setup.status.enabled);
  const manualOnly = Boolean(config && !config.registration_command && !config.install_uri);
  const testPrompt = t(canCapture ? "mcpCaptureTestPrompt" : "mcpTestPrompt");

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const refresh = async () => {
      try {
        const [next,auth] = await Promise.all([readMcpSetupInfo(),readMcpAuthorization()]);
        if (!active) return;
        setSetup(next); setCanEdit(next.status.can_edit_annotations); setCanCapture(next.status.can_capture ?? false);
        setAuthorization(auth);
        setPort(previous=>previous||String(next.port));
        setCheck((previous) => previous?.instance_id === next.status.instance_id ? previous : null);
      } catch (e) { if (active) setError(String(e)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [desktop]);

  async function changeService(enabled: boolean, edit: boolean, nextPort?:number, capture = canCapture) {
    setBusy(true); setError(""); setCheck(null);
    try {
      await configureMcp(enabled, edit,nextPort,capture);
      setSetup(await readMcpSetupInfo()); setCanEdit(edit); setCanCapture(capture);
      setAuthorization(await readMcpAuthorization());
    } catch (e) {
      setError(String(e));
      try { setSetup(await readMcpSetupInfo()); } catch { /* Keep the actionable error. */ }
    } finally { setBusy(false); }
  }
  async function authorize(requestId:string,allow:boolean) {
    setBusy(true);setError("");
    try {await decideMcpAuthorization(requestId,allow);setAuthorization(await readMcpAuthorization());}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function revoke(grantId:string) {
    setBusy(true);setError("");
    try {await revokeMcpAuthorization(grantId);setAuthorization(await readMcpAuthorization());}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function selfCheck() {
    setBusy(true); setError(""); setCheck(null);
    try { setCheck(await checkMcpConnection()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function install() {
    setBusy(true); setError(""); setInstallOpened(false);
    try { await openMcpClient(client); setInstallOpened(true); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function copy(text: string, label: string) {
    try { await writeText(text); setCopied(label); setError(""); }
    catch (e) { setError(String(e)); }
  }
  function copyLabel(label: string, key: string) {
    return <>{copied === label ? <Check size={13} /> : <Copy size={13} />}{t(copied === label ? "mcpCopied" : key)}</>;
  }
  function manualConfig() {
    if (!config) return null;
    return <div className="mcpManualBody">
      <p className="mcpHint">{t("mcpMergeHint")}</p>
      {config.location && <p className="mcpPath">{t("mcpConfigLocation")}<code>{config.location}</code></p>}
      <textarea aria-label={t("mcpAgentConfig")} className="mcpConfig" spellCheck={false} readOnly value={config.content} onFocus={(e) => e.target.select()} rows={7} />
      <button type="button" disabled={!ready || busy} onClick={() => void copy(config.content, "config")}>{copyLabel("config", "mcpCopyConfig")}</button>
    </div>;
  }

  return <section className="mcpPanel">
    <header className="mcpIntro"><PlugZap size={21} /><div><h3>{t("mcpSetupTitle")}</h3><p>{t("mcpSetupDescription")}</p></div></header>
    {!desktop && <p className="mcpNotice" role="status">{t("mcpDesktopRequired")}</p>}
    {setup && !setup.supported && <p className="mcpNotice" role="alert">{t("mcpUnsupported")}</p>}
    <section className="mcpSetupCard">
      <h4 className="mcpStepHeading"><span>1</span>{t("mcpStepEnable")}</h4>
      <div className="mcpServiceRow"><div className={`mcpServiceStatus ${setup?.status.enabled ? "enabled" : ""}`} role="status"><i />{t(setup?.status.enabled ? "mcpServiceOn" : "mcpServiceOff")}</div>
        <button type="button" className={setup?.status.enabled ? "" : "mcpPrimary"} disabled={busy || !setup?.supported} onClick={() => void changeService(!setup?.status.enabled, canEdit)}>{t(setup?.status.enabled ? "mcpDisable" : "mcpEnable")}</button>
      </div>
      <label className="mcpPermission"><input id="mcp-annotations" type="checkbox" checked={canEdit} disabled={busy || !setup?.supported}
        onChange={(e) => void changeService(Boolean(setup?.status.enabled), e.target.checked)} /><span>{t("mcpAllowAnnotations")}<small>{t("mcpPermissionHint")}</small></span></label>
      <label className="mcpPermission"><input id="mcp-capture" type="checkbox" checked={canCapture} disabled={busy || !setup?.supported}
        onChange={(e) => void changeService(Boolean(setup?.status.enabled), canEdit, undefined, e.target.checked)} /><span>{t("mcpAllowCapture")}<small>{t("mcpCapturePermissionHint")}</small></span></label>
      <p className="mcpHint">{t("mcpPersistenceHint")}</p>
    </section>
    {setup?.auto_start_requested && !setup.status.enabled && <p className="mcpNotice" role="status">{t("mcpAutoStartFailed")}</p>}
    {authorization.pending.map(request=><section className="mcpSetupCard mcpAuthorization" key={request.request_id} role="status">
      <h4>{t("mcpAuthorizationRequest")}</h4><strong>{request.client_name}</strong><p className="mcpHint">{t("mcpAuthorizationHint")}</p>
      <code className="mcpCallback">{request.redirect_uri}</code>
      <div className="mcpAuthorizationActions"><button type="button" disabled={busy} onClick={()=>void authorize(request.request_id,false)}>{t("mcpDeny")}</button><button type="button" className="mcpPrimary" disabled={busy} onClick={()=>void authorize(request.request_id,true)}>{t("mcpApprove")}</button></div>
    </section>)}
    <section className="mcpSetupCard">
      <h4 className="mcpStepHeading"><span>2</span>{t("mcpStepConnect")}</h4>
      <div className="mcpEndpoint"><code>{setup?.endpoint??"http://127.0.0.1:10531/mcp"}</code><button type="button" aria-label={t("mcpCopyUrl")} disabled={!ready||busy} onClick={()=>void copy(setup!.endpoint,"url")}>{copyLabel("url","mcpCopyUrl")}</button></div>
      <label className="mcpFieldLabel" htmlFor="mcp-client">{t("mcpClient")}</label>
      <select id="mcp-client" value={client} onChange={(e) => { setClient(e.target.value); setCopied(""); setInstallOpened(false); setError(""); }}>
        {Object.entries(clients).map(([id, name]) => <option key={id} value={id}>{id === "generic" ? t("mcpOtherClient") : name}</option>)}
      </select>
      {config?.registration_command && <>
        <p className="mcpHint">{t("mcpCommandHint", { client: clients[client] })}</p>
        <div className="mcpCommandHeader"><Terminal size={12} /><span>{t("mcpCommandLabel")}</span></div>
        <textarea aria-label={t("mcpCommandLabel")} className="mcpCommand" spellCheck={false} readOnly value={config.registration_command} onFocus={(e) => e.target.select()} rows={3} />
        <button type="button" className="mcpPrimary" disabled={!ready || busy} onClick={() => void copy(config.registration_command!, "command")}>{copyLabel("command", "mcpCopyCommand")}</button>
      </>}
      {config?.install_uri && <>
        <p className="mcpHint">{t("mcpInstallHint")}</p>
        <button type="button" className="mcpPrimary" disabled={!ready || busy} onClick={() => void install()}><ExternalLink size={13} />{t("mcpInstallClient", { client: clients[client] })}</button>
        {installOpened && <p className="mcpHint" role="status">{t("mcpInstallOpened")}</p>}
      </>}
      {config && <p className="mcpNextStep">{t(`mcpNext_${client}`)}</p>}
      <p className="mcpHint">{t("mcpOAuthHint")}</p>
      {config && (manualOnly ? manualConfig() : <details className="mcpManual" key={client}><summary>{t("mcpManualConfig")}</summary>{manualConfig()}</details>)}
      {config && <a className="mcpDocsLink" href={config.docs_url} target="_blank" rel="noreferrer">{t("mcpClientDocs")}<ExternalLink size={11} /></a>}
    </section>
    <section className="mcpSetupCard">
      <h4 className="mcpStepHeading"><span>3</span>{t("mcpStepVerify")}</h4>
      <p className="mcpHint">{t(canCapture ? "mcpCaptureVerifyHint" : "mcpVerifyHint")}</p>
      <button type="button" className="mcpPrimary" disabled={!ready || busy} onClick={() => void copy(testPrompt, "prompt")}>{copyLabel("prompt", "mcpCopyPrompt")}</button>
      <details className="mcpPromptDetails"><summary>{t("mcpTestPromptLabel")}</summary><textarea id="mcp-test-prompt" className="mcpConfig" readOnly value={testPrompt} rows={5} /></details>
      <button type="button" disabled={!ready || busy} onClick={() => void selfCheck()}><ShieldCheck size={13} />{t(busy ? "mcpWorking" : "mcpCheck")}</button>
      {check && <p role="status" className="mcpCheckSuccess">{t("mcpCheckPassed", { count: check.tool_count })}</p>}
    </section>
    <details className="mcpConnectionDetails"><summary>{t("mcpConnectionDetails")}</summary>
      <p className="mcpHint">{t("mcpCheckMeaning")}</p>
      <label className="mcpPort" htmlFor="mcp-port">{t("mcpPort")}<input id="mcp-port" type="number" min={1024} max={65535} value={port} disabled={busy||!setup?.supported} onChange={e=>setPort(e.target.value)}/></label>
      <button type="button" disabled={busy||!setup?.supported||!/^\d+$/.test(port)||Number(port)<1024||Number(port)>65535||Number(port)===setup.port} onClick={()=>void changeService(Boolean(setup?.status.enabled),canEdit,Number(port))}>{t("mcpApplyPort")}</button>
      <p className="mcpHint">{t("mcpPortHint")}</p>
      <p className="mcpHint">{t("mcpAuthorizedClients")}</p>
      {authorization.clients.length===0&&<p className="mcpHint">{t("mcpNoClients")}</p>}
      {authorization.clients.map(client=><div className="mcpAuthorizedClient" key={client.grant_id}><span>{client.client_name}</span><button type="button" disabled={busy} onClick={()=>void revoke(client.grant_id)}>{t("mcpRevoke")}</button></div>)}
      <p className="mcpHint">{t("mcpLocalOnly")}</p>
    </details>
    {error && <p role="alert" className="mcpError">{error}</p>}
  </section>;
}
