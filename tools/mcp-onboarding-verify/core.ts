export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command === "plugin:clipboard-manager|write_text") { (window as unknown as { fixtureClipboard: string }).fixtureClipboard = String(args?.text); return undefined as T; }
  if (command === "open_mcp_client") { (window as unknown as { fixtureOpenedClient: string }).fixtureOpenedClient = String(args?.clientId); return undefined as T; }
  const path = { mcp_setup_info: "setup", configure_mcp: "configure", check_mcp_connection: "check", workbench_snapshot: "snapshot",mcp_authorization_status:"authorization",mcp_decide_authorization:"decide",mcp_revoke_authorization:"revoke" }[command];
  if (!path) throw new Error(`Unexpected fixture invoke: ${command}`);
  return request(path, args, path === "setup" ? "GET" : "POST") as Promise<T>;
}
export async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`/fixture/${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}
