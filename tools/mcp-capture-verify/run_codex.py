#!/usr/bin/env python3
"""Run from SigPilot's real PTY. No fixture, mock MCP, or USB driver bypass."""
import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

PREFIX = "SIGPILOT_VERIFY_EVENT "
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ALLOWED_TOOLS = ["sigpilot_list_capabilities", "sigpilot_list_devices",
                 "sigpilot_get_device_capabilities", "sigpilot_start_capture",
                 "sigpilot_get_capture_status", "sigpilot_stop_capture", "sigpilot_release_capture",
                 "sigpilot_get_context", "sigpilot_query_edges", "sigpilot_apply_annotations",
                 "sigpilot_list_annotations", "sigpilot_focus_view"]
AUTHORIZED_WRITES = ["sigpilot_start_capture", "sigpilot_stop_capture",
                     "sigpilot_release_capture", "sigpilot_apply_annotations", "sigpilot_focus_view"]


def event(kind, **fields):
    print(PREFIX + json.dumps({"kind": kind, **fields}, ensure_ascii=False), flush=True)


def redacted(text):
    # Authorization URLs/codes and bearer tokens must not enter evidence files.
    text = re.sub(r"https?://[^\s\"<>]+(?:oauth|authorize)[^\s\"<>]*", "[local OAuth URL omitted]", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9_.~-]+", r"\1[redacted]", text)
    text = re.sub(r"(?i)([\"']?(?:access_token|refresh_token|api_key)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", r"\1[redacted]", text)
    return text


def local_url(url, endpoint, authorize=False):
    parsed = urllib.parse.urlsplit(url)
    expected = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port != expected.port:
        raise RuntimeError("OAuth URL is not the explicitly selected loopback MCP service")
    if authorize:
        if parsed.path != "/oauth/authorize":
            raise RuntimeError("Unexpected authorization endpoint")
        fields = urllib.parse.parse_qs(parsed.query)
        if fields.get("resource") != [endpoint] or fields.get("code_challenge_method") != ["S256"]:
            raise RuntimeError("OAuth request is missing the expected resource or PKCE")
    return parsed


def get(url):
    # No ambient proxy should receive local authorization codes.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=10) as response:
        return response.read(512 * 1024).decode("utf-8")


def complete_oauth(url, endpoint):
    parsed = local_url(url, endpoint, authorize=True)
    redirect = urllib.parse.parse_qs(parsed.query)["redirect_uri"][0]
    callback = urllib.parse.urlsplit(redirect)
    if callback.scheme != "http" or callback.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Codex callback is not loopback")
    page = get(url)
    match = re.search(r"/oauth/status/([a-zA-Z0-9_-]{16,128})", page)
    if not match:
        raise RuntimeError("SigPilot did not create an authorization request")
    request_id = match.group(1)
    # This exact ID/redirect is matched by the trusted desktop script before
    # approving. It is not persisted to the test report or command log.
    event("oauth_pending", request_id=request_id, redirect_uri=redirect)
    status_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/oauth/status/" + request_id, "", ""))
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        value = json.loads(get(status_url))
        if "error" in value:
            raise RuntimeError("SigPilot OAuth authorization failed")
        if value.get("redirect"):
            target = urllib.parse.urlsplit(value["redirect"])
            if (target.scheme, target.netloc, target.path) != (callback.scheme, callback.netloc, callback.path):
                raise RuntimeError("Authorization callback changed unexpectedly")
            get(value["redirect"])
            event("phase", name="Codex OAuth callback completed")
            return
        time.sleep(0.2)
    raise RuntimeError("SigPilot authorization was not approved within 120 seconds")


def run(command, log, timeout, endpoint=None):
    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    env["BROWSER"] = "/usr/bin/true"
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
    lines = queue.Queue()
    def read():
        for line in process.stdout:
            lines.put(line)
        lines.put(None)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    started = time.monotonic()
    finished_reading = False
    oauth = None
    oauth_errors = []
    tool_calls = []
    bytes_written = 0
    with log.open("w") as stream:
        try:
            while not finished_reading or process.poll() is None:
                if time.monotonic() - started > timeout:
                    raise RuntimeError("Codex command exceeded its verification deadline")
                try:
                    line = lines.get(timeout=0.2)
                except queue.Empty:
                    if oauth_errors:
                        raise RuntimeError(oauth_errors[0])
                    continue
                if line is None:
                    finished_reading = True
                    continue
                clean = ANSI.sub("", line)
                safe = redacted(clean)
                bytes_written += len(safe.encode())
                if bytes_written > 16 * 1024 * 1024:
                    raise RuntimeError("Codex verification log exceeded 16 MiB")
                stream.write(safe)
                stream.flush()
                if endpoint and oauth is None:
                    match = re.search(r"http://127\.0\.0\.1:\d+/oauth/authorize\?[^\s<>]+", clean)
                    if match:
                        url = match.group(0).rstrip("\"')")
                        local_url(url, endpoint, authorize=True)
                        def authorize():
                            try:
                                complete_oauth(url, endpoint)
                            except Exception as error:
                                oauth_errors.append(str(error))
                        oauth = threading.Thread(target=authorize, daemon=True)
                        oauth.start()
                try:
                    payload = json.loads(clean)
                    item = payload.get("item", {})
                    if item.get("type") == "mcp_tool_call" and payload.get("type") == "item.completed":
                        tool_calls.append(item)
                        event("phase", name="Codex MCP call completed: " + str(item.get("tool", "unknown")))
                except (json.JSONDecodeError, AttributeError):
                    pass
            if oauth:
                oauth.join(timeout=1)
            if oauth_errors:
                raise RuntimeError(oauth_errors[0])
            return process.returncode, tool_calls
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            reader.join(timeout=1)


def prompt(name, allow_hardware):
    hardware = """
Then test the actual attached PXLogic (USB device, never substitute Demo for hardware).
Read its capabilities first. Acquire D0..D3 at 1 MHz, duration 10 ms,
8 MiB buffer budget, threshold_volts=1.8, and 10000 ms timeout; use supported finite immediate mode,
no hardware trigger, external trigger or output. If capabilities prohibit an
exact setting, report the mismatch instead of increasing rates or duration.
Poll the acquisition job to a terminal result. Use the returned capture identity
to query D0 transitions in its finite range, then add one timing marker at exact
sample 5 with title "MCP capture verification — sample 5" if annotation permission
is granted. Do not infer signal integrity or
correct protocol decoding from floating inputs. Never reflash firmware manually,
change PWM, or configure outputs. At most one hardware acquisition.
After the marker is successfully written, use sigpilot_focus_view on this USB
capture, channels [0,1,2,3] and exact sample range start=0/end=40, so its marker
position can be checked in the actual desktop. Use schema names and exact integers.
""" if allow_hardware else "Do not prepare or capture any physical USB device. Demo only."
    return f"""Verify the local SigPilot MCP server named {name}.
Use only tools from that MCP server; do not use shell, filesystem, browser,
network, or other MCP servers. This is an authorized bounded acquisition test.
Call tools sequentially; wait for each result before the next call. Do not batch
parallel tool calls. A read-only discovery BUSY can be retried once sequentially.
1. Discover available devices and acquisition permission/capabilities.
2. Read Demo capabilities, start a finite Demo acquisition at 1 MHz on D0..D3,
10 ms duration, 8 MiB buffer budget, threshold_volts=1.8, 10000 ms timeout, and no triggers.
Poll its acquisition status to completion; do not confuse decode jobs with
acquisition jobs. Use exact returned IDs/revisions and schemas.
3. Read the new capture context and query D0 edges. Replay the same acquisition
request_id and arguments once and confirm it does not start another acquisition.
{hardware}
4. Release only the completed Demo test acquisition, then replay its original
start request again and confirm released=true with the same job ID (no new
acquisition). Leave the completed physical USB capture and its sample-5 marker
open in SigPilot for review. If hardware testing was disabled, create the sample-5
marker on Demo before releasing it.
Do not keep retrying a failing device. Stop any acquisition you started if it is
still active when you finish. Return a concise JSON object with demo_success,
hardware_tested, hardware_success, device IDs, job IDs, session IDs, sample counts,
the exact marker sample (if created), and any errors. Never report success without
successful tool results. If necessary tools are missing, report that directly.
"""


def structured(item):
    result = item.get("result") or {}
    if not isinstance(result, dict) or result.get("isError") or result.get("is_error"):
        return None
    for field in ("structured_content", "structuredContent"):
        if isinstance(result.get(field), dict):
            return result[field]
    for block in result.get("content", []):
        if block.get("type") == "text":
            try:
                value = json.loads(block.get("text", ""))
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                pass
    return None


def recovered_busy_calls(calls, name):
    """Only matched later successful retries of read-only discovery are benign."""
    discovery = {"sigpilot_list_capabilities", "sigpilot_list_devices", "sigpilot_get_device_capabilities"}
    recovered = set()
    for index, item in enumerate(calls):
        value = structured(item) or {}
        error = value.get("error") or {}
        if item.get("server") != name or item.get("tool") not in discovery or not isinstance(error, dict) or error.get("code") != "BUSY":
            continue
        if any(later.get("server") == name and later.get("tool") == item.get("tool")
               and later.get("arguments") == item.get("arguments") and later.get("status") == "completed"
               and not later.get("error") and structured(later) is not None
               and not structured(later).get("error") for later in calls[index + 1:]):
            recovered.add(index)
    return recovered


def verify_calls(calls, name, hardware):
    checks = {}
    successful = [(item, structured(item)) for item in calls
                  if item.get("server") == name and item.get("status") == "completed" and not item.get("error")]
    successful = [(item, value) for item, value in successful if value is not None and not value.get("error")]
    checks["only_requested_mcp_server"] = bool(calls) and all(item.get("server") == name for item in calls)
    recovered = recovered_busy_calls(calls, name)
    checks["no_unrecovered_tool_errors"] = bool(calls) and all(index in recovered or (
        item.get("status") == "completed" and not item.get("error")
        and structured(item) is not None and not structured(item).get("error")
    ) for index, item in enumerate(calls))
    devices = {device["id"]: device for item, value in successful if item.get("tool") == "sigpilot_list_devices"
               for device in value.get("devices", [])}
    checks["enumerated_demo"] = any(device.get("kind") == "Fake" for device in devices.values())
    starts = [(item, value) for item, value in successful if item.get("tool") == "sigpilot_start_capture"]
    completed = {value["job_id"]: value for item, value in successful
                 if item.get("tool") == "sigpilot_get_capture_status" and value.get("state") == "completed"
                 and not value.get("released") and not value.get("error")}
    demo_jobs = [value for value in completed.values() if devices.get(value.get("device_id"), {}).get("kind") == "Fake"]
    usb_jobs = [value for value in completed.values() if devices.get(value.get("device_id"), {}).get("kind") == "Usb"]
    checks["demo_completed"] = len(demo_jobs) == 1
    checks["hardware_completed"] = len(usb_jobs) == 1 if hardware else len(usb_jobs) == 0
    checks["hardware_never_retried"] = len({value["job_id"] for _, value in starts
        if devices.get(value.get("device_id"), {}).get("kind") == "Usb"}) <= 1
    checks["bounded_start_requests"] = bool(starts) and all(
        str(item.get("arguments", {}).get("sample_rate_hz")) == "1000000"
        and item.get("arguments", {}).get("enabled_channels") == [0, 1, 2, 3]
        and item.get("arguments", {}).get("mode") == "buffer"
        and item.get("arguments", {}).get("duration_ms") == 10
        and item.get("arguments", {}).get("buffer_size_mb") == 8
        and item.get("arguments", {}).get("threshold_volts") == 1.8
        and not item.get("arguments", {}).get("hardware_trigger")
        and not item.get("arguments", {}).get("protocol_trigger")
        and item.get("arguments", {}).get("timeout_ms") == 10000 for item, _ in starts)
    expected_jobs = demo_jobs + (usb_jobs if hardware else [])
    checks["all_acquisitions_completed"] = bool(starts) and {
        value["job_id"] for _, value in starts
    } == {value["job_id"] for value in expected_jobs}
    samples = []
    for value in expected_jobs:
        metadata = (value.get("summary") or {}).get("metadata") or {}
        context = value.get("context") or {}
        try:
            sample_count = int(metadata.get("sample_count", 0))
            correct = (int(metadata.get("sample_rate_hz", 0)) == 1_000_000
                       and 10_000 <= sample_count <= 10_064
                       and metadata.get("enabled_channels") == [0, 1, 2, 3]
                       and metadata.get("source_device") == value["device_id"]
                       and int(context.get("sample_count", -1)) == sample_count
                       and context.get("finalized") is True)
        except (ValueError, TypeError):
            correct = False
        samples.append({"job_id": value["job_id"], "device_id": value["device_id"],
                        "sample_count": metadata.get("sample_count"), "correct": correct})
    checks["finite_capture_metadata"] = bool(samples) and all(value["correct"] for value in samples)
    queried_sessions = {(item.get("arguments") or {}).get("capture", {}).get("session_id")
                        for item, value in successful if item.get("tool") == "sigpilot_query_edges"
                        and (item.get("arguments") or {}).get("channel") == 0}
    checks["queried_captured_edges"] = bool(expected_jobs) and all(value["session_id"] in queried_sessions for value in expected_jobs)
    target_sessions = {value["session_id"] for value in (usb_jobs if hardware else demo_jobs)}
    checks["exact_sample_5_marker"] = any(
        item.get("tool") == "sigpilot_apply_annotations" and value.get("preview") is False
        and value.get("capture", {}).get("session_id") in target_sessions
        and any(annotation.get("kind") == "timing_point" and str(annotation.get("sample")) == "5"
                for annotation in value.get("upserts", [])) for item, value in successful)
    replay = False
    for index, (item, value) in enumerate(starts):
        for later, again in starts[index + 1:]:
            if item.get("arguments") == later.get("arguments") and value.get("job_id") == again.get("job_id"):
                replay = True
    checks["identical_request_replayed_same_job"] = replay
    released = {value["job_id"] for item, value in successful
                if item.get("tool") == "sigpilot_release_capture" and value.get("released") is True}
    checks["demo_released"] = bool(demo_jobs) and all(value["job_id"] in released for value in demo_jobs)
    checks["released_request_did_not_restart"] = any(value.get("released") is True and value.get("job_id") in released
                                                     for _, value in starts)
    checks["hardware_retained_for_review"] = all(value["job_id"] not in released for value in usb_jobs)
    checks["capabilities_read"] = all(any(item.get("tool") == "sigpilot_get_device_capabilities"
        and (item.get("arguments") or {}).get("device_id") == job["device_id"] for item, _ in successful)
        for job in expected_jobs)
    return checks, samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--allow-hardware", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", args.name):
        raise RuntimeError("Invalid test MCP server name")
    local_url(args.endpoint, args.endpoint)
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"passed": False, "name": args.name, "endpoint": args.endpoint,
              "hardware_authorized": args.allow_hardware, "scope": "Codex CLI from actual SigPilot PTY"}
    try:
        existing = subprocess.run(["codex", "mcp", "get", args.name, "--json"], capture_output=True, text=True)
        if existing.returncode == 0:
            data = json.loads(existing.stdout)
            if data.get("transport", {}).get("url") != args.endpoint:
                raise RuntimeError("An existing MCP server has this name with another endpoint; refusing overwrite")
            report["registration"] = "reused"
        else:
            code, _ = run(["codex", "mcp", "add", args.name, "--url", args.endpoint],
                          args.output / "registration.log", 180, args.endpoint)
            if code != 0:
                raise RuntimeError("codex mcp add failed; see redacted registration.log")
            report["registration"] = "installed"
        event("phase", name="Codex MCP registration ready")
        task = prompt(args.name, args.allow_hardware)
        (args.output / "prompt.txt").write_text(task)
        final = args.output / "codex-result.txt"
        # Per-invocation grants only for the five operations authorized by this
        # bounded test. Keep shell read-only and leave global user policy intact.
        overrides = ["-c", f"mcp_servers.{args.name}.enabled_tools=" + json.dumps(ALLOWED_TOOLS)]
        for tool in AUTHORIZED_WRITES:
            overrides.extend(["-c", f'mcp_servers.{args.name}.tools.{tool}.approval_mode="approve"'])
        code, calls = run(["codex", "exec", "--ephemeral", "--json", "--color", "never", *overrides,
                           "-s", "read-only", "-C", str(args.workspace),
                           "-o", str(final), task], args.output / "codex-events.jsonl", 540)
        report["codex_exit_code"] = code
        report["tool_calls"] = [{"server": item.get("server"), "tool": item.get("tool"),
                                  "status": item.get("status"), "error": item.get("error")}
                                 for item in calls]
        # Require actual acquisition calls and the explicitly requested result,
        # not merely a zero exit code from an assistant that only listed tools.
        if final.exists():
            report["answer"] = redacted(final.read_text())[:16000]
            answer = report["answer"].strip()
            try:
                report["result"] = json.loads(answer[answer.index("{"):answer.rindex("}") + 1])
            except (ValueError, json.JSONDecodeError):
                report["result"] = {}
        report["checks"], report["captures"] = verify_calls(calls, args.name, args.allow_hardware)
        report["transient_busy_retries"] = len(recovered_busy_calls(calls, args.name))
        report["authorized_mcp_write_tools"] = AUTHORIZED_WRITES
        report["passed"] = code == 0 and all(report["checks"].values())
        if not report["passed"]:
            report["error"] = "CLI, expected acquisition calls, or requested Demo/hardware result did not pass"
    except Exception as error:
        report["error"] = redacted(str(error))
        event("failure", message=report["error"])
    finally:
        (args.output / "codex-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        event("done", passed=report["passed"], report=str(args.output / "codex-report.json"),
              codex_exit_code=report.get("codex_exit_code"), hardware_authorized=args.allow_hardware)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
