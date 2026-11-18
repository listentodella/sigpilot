import { invoke } from "@tauri-apps/api/core";
import {
  decodeBinaryGraphFrame,
  type CaptureMetadata,
  type DeviceInfo,
  type GraphFrameRequest,
  type HardwareCaptureCapabilities,
} from "./api";
import type { CaptureRef, WorkbenchSnapshot } from "./workbench";

export interface RemoteSettings {
  port: number;
  listen_on_lan: boolean;
  public_url: string;
  can_edit: boolean;
  can_capture: boolean;
}
export interface RemoteClient {
  id: string;
  name: string;
}
export interface RemoteConnection {
  client: RemoteClient;
  can_edit: boolean;
  can_capture: boolean;
}
export interface RemoteStatus {
  enabled: boolean;
  settings: RemoteSettings;
  access_code: string | null;
  clients: RemoteClient[];
}
export interface RemoteSetup {
  status: RemoteStatus;
  suggested_lan_url: string | null;
}
export interface RemoteSession {
  id: string;
  metadata: CaptureMetadata;
  finalized: boolean;
  owned: boolean;
}
export interface RemoteJob {
  id: string;
  session_id: string;
  state: string;
  error: string | null;
  owned: boolean;
}
export interface RemoteSessions {
  sessions: RemoteSession[];
  captures: RemoteJob[];
}
export class RemoteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function remoteRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  raw = false,
): Promise<Response> {
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    signal,
    headers:
      body === undefined
        ? {}
        : {
            "x-sigpilot-remote": "1",
            "Content-Type": raw
              ? "application/octet-stream"
              : "application/json",
          },
    body:
      body === undefined
        ? undefined
        : raw
          ? (body as Blob)
          : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));
    throw new RemoteError(
      response.status,
      error.error ?? `HTTP ${response.status}`,
    );
  }
  return response;
}
export async function remoteJson<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await remoteRequest(path, body, signal)).json();
}
export const sessionPath = (id: string, suffix: string) =>
  `/sessions/${encodeURIComponent(id)}/${suffix}`;
export const readRemoteSnapshot = (id: string, signal?: AbortSignal) =>
  remoteJson<WorkbenchSnapshot>(sessionPath(id, "snapshot"), undefined, signal);
export async function remoteFrame(
  id: string,
  capture: CaptureRef,
  request: GraphFrameRequest,
  signal: AbortSignal,
) {
  return decodeBinaryGraphFrame(
    await (
      await remoteRequest(
        sessionPath(id, "frame"),
        { capture, request },
        signal,
      )
    ).arrayBuffer(),
  );
}
// randomUUID requires a secure context; LAN HTTP still provides getRandomValues.
export function remoteId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export const remoteDevices = () => remoteJson<DeviceInfo[]>("/devices");
export const remoteCapabilities = (id: string) =>
  remoteJson<HardwareCaptureCapabilities>(
    `/devices/${encodeURIComponent(id)}/capabilities`,
  );
export const readRemoteSetup = () => invoke<RemoteSetup>("remote_setup");
export const configureRemote = (enabled: boolean, settings: RemoteSettings) =>
  invoke<RemoteStatus>("configure_remote", { enabled, settings });
export const revokeRemoteClient = (clientId: string) =>
  invoke<void>("revoke_remote_client", { clientId });
