#!/usr/bin/env python3
"""Actual MCP wire verification; run under limited-run.py on Instabox."""

import json
import os
from pathlib import Path
import platform
import select
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile


def fixture(path):
    metadata = {"version": 1, "source_device": "fixture", "sample_rate_hz": 1_000_000_000,
                "channel_count": 1, "enabled_channels": [0], "unitsize": 1,
                "sample_count": 20, "captured_at": "2026-11-12T00:00:00Z", "labels": ["D0"]}
    transitions = [2, 3, 5, 7, 10, 13, 15]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("project.json", json.dumps({"format": "pxlogic.project.v1", "session": {"name": "MCP fixture", "notes": "", "analyzers": []}, "capture": {
            "kind": "sparse", "metadata": metadata, "channels": [{"channel": 0, "initial_high": False, "transitions_file": "capture/d0.u64"}]}}))
        archive.writestr("capture/d0.u64", b"".join(struct.pack("<Q", edge) for edge in transitions))


class Stdio:
    def __init__(self, binary, root):
        self.log = tempfile.TemporaryFile()
        self.process = subprocess.Popen([binary, "--root", str(root), "--allow-annotations"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, bufsize=0)
        self.counter = 0

    def call(self, method, params, notification=False):
        self.counter += 1
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            message["id"] = self.counter
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        self.process.stdin.flush()
        if notification:
            return None
        deadline = time.monotonic() + 10
        data = bytearray()
        while time.monotonic() < deadline:
            if not select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                break
            byte = self.process.stdout.read(1)
            if not byte:
                break
            data.extend(byte)
            if len(data) > 512 * 1024:
                raise AssertionError("stdio result exceeds budget")
            if byte == b"\n":
                response = json.loads(data)
                data.clear()
                if response.get("id") == message["id"]:
                    return response
        self.log.seek(0)
        raise AssertionError("stdio response missing: " + self.log.read(4000).decode("utf-8", "replace"))

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=3)
        self.log.close()


def tool(client, name, arguments, expect_error=None):
    response = client.call("tools/call", {"name": name, "arguments": arguments})
    assert "error" not in response, response
    result = response["result"]
    body = result["structuredContent"]
    if expect_error:
        assert result["isError"] is True and body["error"]["code"] == expect_error, result
    else:
        assert result.get("isError") is not True, result
    return body


def exercise(client, root):
    init = client.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "sigpilot-wire-smoke", "version": "1"}})
    assert "error" not in init, init
    client.call("notifications/initialized", {}, notification=True)
    catalog = client.call("tools/list", {})["result"]["tools"]
    names = {item["name"] for item in catalog}
    assert {"sigpilot_open_capture", "sigpilot_query_edges", "sigpilot_apply_annotations", "sigpilot_run_analysis",
            "sigpilot_query_frame_sequence", "sigpilot_query_transactions", "sigpilot_correlate_pulses", "sigpilot_compile_trigger"} <= names
    assert len(names) == 29
    for item in catalog:
        assert item["inputSchema"]["additionalProperties"] is False
    compile_exercise(client)
    opened = tool(client, "sigpilot_open_capture", {"session_id": "wire-fixture", "path": str(root / "capture.pxl")})
    reference = {k: opened[k] for k in ("session_id", "capture_id", "data_revision")}
    derived_exercise(client, reference)
    analyzer_exercise(client, reference)
    prompt_exercise(client, reference)
    timing_exercise(client, root)
    assert len(client.call("resources/list", {})["result"]["resources"]) == 3
    assert len(client.call("resources/templates/list", {})["result"]["resourceTemplates"]) == 6
    resource_base = f"sigpilot://sessions/{reference['session_id']}/captures/{reference['capture_id']}/{reference['data_revision']}/"
    summary = client.call("resources/read", {"uri": resource_base + "summary"})["result"]
    assert json.loads(summary["contents"][0]["text"])["capture_id"] == reference["capture_id"]
    assert "error" in client.call("resources/read", {"uri": "file:///etc/hosts"})
    query = {"capture": reference, "channel": 0, "range": {"start_sample": "0", "end_sample": "20"}, "limit": 2}
    page = tool(client, "sigpilot_query_edges", query)["page"]
    assert [edge["sample"] for edge in page["items"]] == ["2", "3"]
    assert page["next_start_sample"] == "5" and page["truncated"]
    resumed = tool(client, "sigpilot_query_edges", {**query, "range": {"start_sample": "5", "end_sample": "20"}, "limit": 100})["page"]
    assert [edge["sample"] for edge in resumed["items"]] == ["5", "7", "10", "13", "15"]
    pulse = tool(client, "sigpilot_run_analysis", {"capture": reference, "provider_id": "sigpilot.pulse_width", "channel": 0,
        "original_range": {"start_sample": "0", "end_sample": "20"}, "start_sample": "0", "high": True, "min_width_samples": "1", "max_width_exclusive": "3"})
    assert [p["width_samples"] for p in pulse["page"]["items"]] == ["1", "2"]
    generic = tool(client, "sigpilot_run_analysis", {"capture": reference, "provider_id": "sigpilot.range_measure", "channel": 0,
        "original_range": {"start_sample": "0", "end_sample": "20"}, "start_sample": "0", "parameters": {}})
    assert generic["page"]["high_samples"] == "11"
    assert generic["evidence_refs"]
    tool(client, "sigpilot_run_analysis", {"capture": reference, "provider_id": "sigpilot.range_measure", "channel": 0,
        "original_range": {"start_sample": "0", "end_sample": "20"}, "start_sample": "0", "parameters": {"script": "fake"}}, expect_error="INVALID_INPUT")
    point = tool(client, "sigpilot_measure", {"capture": reference, "channel": 0, "mode": "point", "sample": "5"})["measurement"]
    assert point["pulse_width_samples"] == "2" and point["period_samples"] == "5" and point["complete_pulse"]
    measured = tool(client, "sigpilot_measure", {"capture": reference, "channel": 0, "mode": "range", "original_range": {"start_sample": "0", "end_sample": "20"}})["measurement"]
    assert measured["high_samples"] == "11" and measured["positive_duty"] == {"numerator": "11", "denominator": "20"}
    evidence = tool(client, "sigpilot_get_evidence", {"capture": reference, "refs": [pulse["page"]["items"][1]["evidence_ref"]], "context_samples": "2"})
    assert evidence["evidence"][0]["observed"]["width_samples"] == "2"
    assert evidence["evidence"][0]["verification"] == "runtime_computed"
    resource_evidence = client.call("resources/read", {"uri": resource_base + "evidence/" + pulse["page"]["items"][1]["evidence_ref"]})["result"]
    assert json.loads(resource_evidence["contents"][0]["text"])["evidence"][0]["observed"]["width_samples"] == "2"
    report_exercise(client, reference, resource_base, [p["evidence_ref"] for p in pulse["page"]["items"]])
    tool(client, "sigpilot_get_evidence", {"capture": reference, "refs": ["evidence-forged"]}, expect_error="EVIDENCE_NOT_FOUND")
    annotation = {"kind": "channel_annotation", "channel": 0, "sample": "5", "title": "2 ns pulse", "color": "#ffc44d", "evidence_refs": [pulse["page"]["items"][1]["evidence_ref"]]}
    commit = {"capture": reference, "expected_annotation_revision": "0", "request_id": "wire-mark", "operations": [{"op": "create", "annotation": annotation}]}
    preview = tool(client, "sigpilot_apply_annotations", {**commit, "preview": True})
    assert preview["annotation_revision"] == "0"
    applied = tool(client, "sigpilot_apply_annotations", commit)
    retried = tool(client, "sigpilot_apply_annotations", commit)
    assert applied["upserts"][0]["id"] == retried["upserts"][0]["id"]
    assert applied["upserts"][0]["source"] == "assistant"
    listed = tool(client, "sigpilot_list_annotations", {"capture": reference, "annotation_revision": "1"})
    assert len(listed["annotations"]) == 1 and listed["annotations"][0]["sample"] == "5"
    rule = {"schema_version": "1", "steps": [{"event": {"type": "edge", "channel": 0, "direction": "rising"},
        "guards": [{"channel": 0, "high": False, "phase": "before"}]}]}
    validation = tool(client, "sigpilot_validate_trigger", {"capture": reference, "rule": rule})["validation"]
    assert validation["satisfiability"] == "satisfiable_in_model"
    impossible = {"schema_version": "1", "steps": [{**rule["steps"][0], "guards": [{"channel": 0, "high": False, "phase": "after"}]}]}
    assert tool(client, "sigpilot_validate_trigger", {"capture": reference, "rule": impossible})["validation"]["satisfiability"] == "proven_unsatisfiable"
    replay = tool(client, "sigpilot_simulate_trigger", {"capture": reference, "range": {"start_sample": "0", "end_sample": "20"},
        "rule": rule, "request_id": "trigger-replay", "limit": 100})
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        job = tool(client, "sigpilot_get_job", {"job_id": replay["job_id"]})
        if job["state"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.01)
    assert job["state"] == "completed", job
    assert job["result"]["simulation"]["total_matches"] == "4"
    assert job["result"]["simulation"]["matches"][0]["anchor_sample"] == "2"
    level_rule = {"schema_version":"1", "steps":[{"event":{"type":"level","channel":0,"high":False}}]}
    level = wait_job(client, tool(client,"sigpilot_simulate_trigger",{"capture":reference,"range":{"start_sample":"0","end_sample":"20"},"rule":level_rule,"request_id":"level-replay"}))
    assert level["result"]["simulation"]["matches"][0]["anchor_sample"] == "0"
    assert level["result"]["simulation"]["matches"][0]["stages"][0]["eligible_range"] == {"start_sample":"0","end_sample":"2"}
    pulse_rule = {"schema_version":"1","steps":[{"event":{"type":"pulse_width","channel":0,"high":True,"min_width_samples":"1","max_width_exclusive":"3","anchor":"pulse_end"}}]}
    closing = wait_job(client,tool(client,"sigpilot_simulate_trigger",{"capture":reference,"range":{"start_sample":"0","end_sample":"20"},"rule":pulse_rule,"request_id":"pulse-end-proof"}))
    match = closing["result"]["simulation"]["matches"][0]
    assert match["anchor_sample"] == "3" and match["range"]["end_sample"] == "4"
    assert match["stages"][0]["pulse_range"] == {"start_sample":"2","end_sample":"3"}
    proof_preview = tool(client,"sigpilot_apply_annotations",{"capture":reference,"expected_annotation_revision":"1","request_id":"closing-preview","preview":True,"operations":[{"op":"create","annotation":{"kind":"timing_point","sample":"3","title":"closing edge","color":"#123456","evidence_refs":[match["evidence_ref"]]}}]})
    assert proof_preview["annotation_revision"] == "1"
    decode_exercise(client, root)
    tool(client, "sigpilot_apply_annotations", {**commit, "request_id": "stale-edit"}, expect_error="VERSION_CONFLICT")
    undo = {"capture": reference, "expected_annotation_revision": "1", "batch_id": applied["batch_id"], "request_id": "undo-mark"}
    assert tool(client, "sigpilot_undo_annotations", {**undo, "preview": True})["annotation_revision"] == "1"
    undone = tool(client, "sigpilot_undo_annotations", undo)
    assert undone["annotation_revision"] == "2" and undone["deleted_ids"] == [applied["upserts"][0]["id"]]
    assert tool(client, "sigpilot_undo_annotations", undo) == undone
    marker_kinds = tool(client, "sigpilot_apply_annotations", {"capture": reference, "expected_annotation_revision": "2", "request_id": "all-kinds", "operations": [
        {"op": "create", "id": "point", "annotation": {"kind": "timing_point", "sample": "2", "title": "T0", "color": "#123456"}},
        {"op": "create", "id": "pair", "annotation": {"kind": "timing_pair", "sample": "3", "end_sample": "3", "title": "P0", "color": "#123456"}},
        {"op": "create", "id": "range", "annotation": {"kind": "range_annotation", "sample": "3", "end_sample": "20", "channel": 0, "title": "window", "color": "#123456"}},
    ]})
    assert len(marker_kinds["upserts"]) == 3
    tool(client, "sigpilot_undo_annotations", {"capture": reference, "expected_annotation_revision": "3", "batch_id": marker_kinds["batch_id"], "request_id": "undo-kinds"})
    assert tool(client, "sigpilot_get_context", {"session_id": reference["session_id"]})["annotation_count"] == "0"
    tool(client, "sigpilot_focus_view", {"capture": reference, "range": {"start_sample": "2", "end_sample": "8"}}, expect_error="GUI_UNAVAILABLE")
    tool(client, "sigpilot_open_capture", {"session_id": "denied", "path": "/etc/hosts"}, expect_error="ACCESS_DENIED")
    print(json.dumps({"transport": "stdio", "protocol": "2025-11-25", "tools": len(catalog), "exact_edges": "passed", "pulse_scan": "passed", "annotation_preview_retry_conflict": "passed", "file_roots": "passed"}))


def derived_exercise(client, capture):
    request={"capture":capture,"target_session_id":"derived-wire","channels":[0],"max_width_exclusive":"3","high":True,"request_id":"derive-wire"}
    preview=tool(client,"sigpilot_create_derived_capture",{**request,"preview":True})
    assert preview["preview"] and preview["derivation"]["modifications"][0]["replaced_pulses"]=="2"
    context=tool(client,"sigpilot_create_derived_capture",request)["context"]
    assert context["sample_count"]=="20" and context["derivation"]["mapping_offset_sample"]=="0"
    assert tool(client,"sigpilot_create_derived_capture",request)["replayed"] is True
    tool(client,"sigpilot_create_derived_capture",{**request,"max_width_exclusive":"4"},expect_error="REQUEST_ID_CONFLICT")
    reference={k:context[k] for k in ("session_id","capture_id","data_revision")}
    edges=tool(client,"sigpilot_query_edges",{"capture":reference,"channel":0,"range":{"start_sample":"0","end_sample":"20"}})["page"]["items"]
    assert [e["sample"] for e in edges]==["10","13","15"]
    source=tool(client,"sigpilot_query_edges",{"capture":capture,"channel":0,"range":{"start_sample":"0","end_sample":"20"}})["page"]["items"]
    assert [e["sample"] for e in source]==["2","3","5","7","10","13","15"]
    print(json.dumps({"derived_capture":"passed","source_unchanged":"passed","preview_replay_conflict":"passed"}))


def wait_job(client, submitted):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        job = tool(client,"sigpilot_get_job",{"job_id":submitted["job_id"]})
        if job["state"] in ("completed","failed","cancelled"):
            assert job["state"] == "completed", job
            return job
        time.sleep(0.01)
    raise AssertionError("job did not complete")


def analyzer_exercise(client, capture):
    before = tool(client,"sigpilot_get_context",{"session_id":capture["session_id"]})
    assert before["config_revision"] == "0" and before["analyzer_count"] == "0"
    create = {"capture":capture,"expected_config_revision":"0","request_id":"analyzer-create",
              "operation":{"op":"create","id":"wire-uart","name":"UART wire","config":{"protocol":"UART","settings":{"channel":0,"baud_rate":"100000"}}}}
    preview = tool(client,"sigpilot_configure_analyzer",{**create,"preview":True})
    assert preview["config_revision"] == "0"
    assert tool(client,"sigpilot_get_analyzers",{"capture":capture,"config_revision":"0"})["items"] == []
    result = tool(client,"sigpilot_configure_analyzer",create)
    assert tool(client,"sigpilot_configure_analyzer",create) == result
    listed = tool(client,"sigpilot_get_analyzers",{"capture":capture,"config_revision":"1"})
    assert listed["items"][0]["id"] == "wire-uart" and listed["items"][0]["source"] == "assistant"
    assert listed["items"][0]["config"]["settings"]["baud_rate"] == "100000"
    assert listed["items"][0]["mcp_run_supported"]
    tool(client,"sigpilot_get_analyzers",{"capture":capture,"config_revision":"0"},expect_error="VERSION_CONFLICT")
    tool(client,"sigpilot_configure_analyzer",{**create,"request_id":"stale-config"},expect_error="VERSION_CONFLICT")
    delete = {"capture":capture,"expected_config_revision":"1","request_id":"analyzer-delete","operation":{"op":"delete","id":"wire-uart"}}
    assert tool(client,"sigpilot_configure_analyzer",delete)["config_revision"] == "2"
    after = tool(client,"sigpilot_get_context",{"session_id":capture["session_id"]})
    assert after["annotation_revision"] == before["annotation_revision"] and after["analyzer_count"] == "0"
    tool(client,"sigpilot_run_decode",{"capture":capture,"range":{"start_sample":"0","end_sample":"20"},"request_id":"mixed",
        "analyzer_id":"wire-uart","expected_config_revision":"2","config":create["operation"]["config"]},expect_error="INVALID_INPUT")


def report_exercise(client, capture, resource_base, refs):
    before = tool(client,"sigpilot_get_context",{"session_id":capture["session_id"]})
    create = {"capture":capture,"expected_report_revision":"0","request_id":"report-create","operation":{"op":"create","title":"Selected pulse observations","note":"Cause unconfirmed","evidence_refs":refs}}
    preview = tool(client,"sigpilot_apply_reports",{**create,"preview":True})
    assert preview["report_revision"] == "0" and preview["upsert"]["report_id"] is None
    applied = tool(client,"sigpilot_apply_reports",create)
    assert tool(client,"sigpilot_apply_reports",create) == applied
    id = applied["upsert"]["report_id"]
    assert applied["upsert"]["source"] == "assistant"
    listed = tool(client,"sigpilot_get_reports",{"capture":capture,"report_revision":"1"})
    assert len(listed["items"]) == 1 and listed["items"][0]["report_id"] == id
    page = tool(client,"sigpilot_get_reports",{"capture":capture,"report_id":id,"limit":1})
    assert page["next_index"] == "1" and page["findings"][0]["evidence_ref"] == refs[0]
    last = tool(client,"sigpilot_get_reports",{"capture":capture,"report_id":id,"start_index":"1"})
    assert last["complete"] and last["findings"][0]["evidence_ref"] == refs[1]
    resource = client.call("resources/read",{"uri":resource_base+f"reports/{id}/pages/0"})["result"]
    assert len(json.loads(resource["contents"][0]["text"])["findings"]) == 2
    for format in ("json", "markdown"):
        content = ""
        offset = "0"
        while True:
            chunk = tool(client,"sigpilot_export_report",{"capture":capture,"report_revision":"1","report_id":id,"format":format,"offset":offset,"max_bytes":128})
            assert len(chunk["content"].encode()) <= 128 and chunk["file_write"] is False
            content += chunk["content"]
            if chunk["complete"]:
                assert len(content.encode()) == int(chunk["total_bytes"])
                break
            assert int(chunk["next_offset"]) > int(offset)
            offset = chunk["next_offset"]
        if format == "json":
            assert json.loads(content)["findings"][1]["evidence_ref"] == refs[1]
        else:
            assert content.startswith("# Selected pulse observations") and "## Observation 2" in content
    tool(client,"sigpilot_export_report",{"capture":capture,"report_revision":"0","report_id":id,"format":"json"},expect_error="VERSION_CONFLICT")
    tool(client,"sigpilot_get_reports",{"capture":capture,"report_revision":"0"},expect_error="VERSION_CONFLICT")
    tool(client,"sigpilot_get_reports",{"capture":capture,"report_id":id,"report_revision":"1"},expect_error="INVALID_INPUT")
    after = tool(client,"sigpilot_get_context",{"session_id":capture["session_id"]})
    assert before["annotation_revision"] == after["annotation_revision"] and after["report_count"] == "1"
    delete = {"capture":capture,"expected_report_revision":"1","request_id":"report-delete","operation":{"op":"delete","report_id":id}}
    assert tool(client,"sigpilot_apply_reports",delete)["report_revision"] == "2"
    tool(client,"sigpilot_get_reports",{"capture":capture,"report_id":id},expect_error="REPORT_NOT_FOUND")
    print(json.dumps({"report_preview_retry_cas_resource_pages":"passed","report_json_markdown_chunks":"passed","annotation_revision_unchanged":True}))


def prompt_exercise(client, capture):
    prompts=client.call("prompts/list",{})["result"]["prompts"]
    assert len(prompts)==3 and len({p["name"] for p in prompts})==3
    for name,args in [
        ("sigpilot_scan_and_mark_pulses",{"channel":"0","max_width_samples":"3"}),
        ("sigpilot_protocol_event_to_waveform",{"goal":"address 0x50 with NACK"}),
        ("sigpilot_diagnose_trigger",{"objective":"D0 rising then D1 pulse"})]:
        response=client.call("prompts/get",{"name":name,"arguments":{"session_id":capture["session_id"],**args}})
        assert "error" not in response,response
        assert response["result"]["messages"][0]["role"]=="user"
        assert "sigpilot_get_context" in response["result"]["messages"][0]["content"]["text"]
    assert "error" in client.call("prompts/get",{"name":"sigpilot_scan_and_mark_pulses","arguments":{"session_id":capture["session_id"],"channel":"0","max_width_samples":"03"}})
    assert "error" in client.call("prompts/list",{"cursor":"invalid"})
    print(json.dumps({"prompts":3,"workflow_arguments":"passed"}))


def timing_exercise(client, root):
    path=root/"timing.pxl"
    metadata={"version":1,"source_device":"timing-fixture","sample_rate_hz":1000000,"channel_count":2,"enabled_channels":[0,1],"unitsize":1,
              "sample_count":40,"captured_at":"2026-11-13T00:00:00Z","labels":["CLK","DATA"]}
    edges=[[10,15,20],[7,12,20,23]]
    with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("project.json",json.dumps({"format":"pxlogic.project.v1","session":{"name":"timing","notes":"","analyzers":[]},"capture":{"kind":"sparse","metadata":metadata,
            "channels":[{"channel":c,"initial_high":False,"transitions_file":f"capture/d{c}.u64"} for c in (0,1)]}}))
        for c in (0,1):archive.writestr(f"capture/d{c}.u64",b"".join(struct.pack("<Q",s) for s in edges[c]))
    opened=tool(client,"sigpilot_open_capture",{"session_id":"timing","path":str(path)})
    capture={k:opened[k] for k in ("session_id","capture_id","data_revision")}
    request={"capture":capture,"provider_id":"sigpilot.multichannel_timing","channel":0,"original_range":{"start_sample":"0","end_sample":"30"},"start_sample":"0",
             "parameters":{"mode":"setup_hold","data_channel":1,"anchor_direction":"rising","min_setup_samples":"3","min_hold_samples":"2","limit":1}}
    first=tool(client,"sigpilot_run_analysis",request)["page"]
    assert first["items"][0]["status"]=="met" and first["next_start_sample"]=="20"
    next=tool(client,"sigpilot_run_analysis",{**request,"start_sample":first["next_start_sample"]})["page"]
    assert next["complete"] and next["items"][0]["simultaneous"] and next["items"][0]["status"]=="violation"
    proof=tool(client,"sigpilot_get_evidence",{"capture":capture,"refs":[next["items"][0]["evidence_ref"]]})
    assert proof["evidence"][0]["channels"]==[0,1]
    delay=tool(client,"sigpilot_run_analysis",{**request,"original_range":{"start_sample":"10","end_sample":"11"},"start_sample":"10",
        "parameters":{"mode":"edge_delay","response_channel":1,"anchor_direction":"rising","response_direction":"falling","min_delay_samples":"0","max_delay_samples":"2"}})["page"]
    assert delay["items"][0]["delay_samples"]=="2" and delay["items"][0]["response"]["sample"]=="12"
    tool(client,"sigpilot_run_analysis",{**request,"parameters":{**request["parameters"],"data_channel":0}},expect_error="INVALID_INPUT")
    print(json.dumps({"multi_channel_timing":"passed","setup_hold_delay_paging_evidence":"passed"}))


def compile_exercise(client):
    profiles = tool(client,"sigpilot_list_capabilities",{})["hardware_triggers"]["profiles"]
    assert len(profiles) == 12 and len({p["profile_id"] for p in profiles}) == 12
    profile = next(p for p in profiles if p["driver_id"] == "pxlogic")
    target = {"profile_id":profile["profile_id"],"mode":"buffer","channel_count":8,"enabled_channels":[0,1],"sample_rate_hz":"1000000"}
    edge = {"type":"edge","channel":0,"direction":"rising"}
    rule = {"schema_version":"1","steps":[{"event":edge}]}
    def compile(rule, target=target):
        result = tool(client,"sigpilot_compile_trigger",{"target":target,"rule":rule})["compilation"]
        assert result["applied"] is False and result["hardware_verified"] is False
        return result
    result = compile(rule)
    assert result["status"] == "supported" and result["artifact"]["target"] == target
    assert compile({"schema_version":"1","steps":[{"event":{"type":"level","channel":0,"high":True}}]})["status"] == "supported"
    guarded = compile({"schema_version":"1","steps":[{"event":edge,"guards":[{"channel":1,"high":False,"phase":"after"}]}]})
    assert guarded["status"] == "unverified" and guarded["artifact"] is None and guarded["candidate_encoding"]["unresolved_semantics"]
    for unsupported in [
        {"schema_version":"1","steps":[{"event":{"type":"pulse_width","channel":0,"high":True,"min_width_samples":"1","max_width_exclusive":"3","anchor":"pulse_end"}}]},
        {"schema_version":"1","steps":[{"event":edge},{"event":edge,"within":{"min_samples":"1","max_samples":"2"}}]},
        {**rule,"holdoff_samples":"1"}]:
        result = compile(unsupported)
        assert result["status"] == "unsupported" and result["artifact"] is None and result["candidate_encoding"] is None
    result = compile(rule,{**target,"sample_rate_hz":"10000000000"})
    assert result["status"] == "unsupported" and result["target"]["sample_rate_hz"] == "10000000000"
    tool(client,"sigpilot_compile_trigger",{"target":{**target,"profile_id":"invented"},"rule":rule},expect_error="TRIGGER_PROFILE_NOT_FOUND")
    print(json.dumps({"offline_trigger_profiles":len(profiles),"compile_supported_unverified_unsupported":"passed","hardware_applied":False}))


def http_check(binary, root):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token = "sigpilot-local-wire-test-token-0123456789"
    log = tempfile.TemporaryFile()
    process = subprocess.Popen([binary, "--http-port", str(port)], env={**os.environ, "SIGPILOT_MCP_TOKEN": token}, stdout=log, stderr=log)
    url = f"http://127.0.0.1:{port}/mcp"
    metadata = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": {"name": "wire-smoke", "version": "1"}, "io.modelcontextprotocol/clientCapabilities": {}}

    def request(headers, body):
        try:
            response = urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Mcp-Method": body["method"], **headers}), timeout=5)
            return response.status, response.read(256 * 1024)
        except urllib.error.HTTPError as error:
            return error.code, error.read(256 * 1024)

    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2): break
            except OSError: time.sleep(0.1)
        discover = {"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": metadata}}
        assert request({}, discover)[0] == 401
        assert request({"Authorization": f"Bearer {token}", "Origin": "https://untrusted.example"}, discover)[0] == 403
        status, raw = request({"Authorization": f"Bearer {token}", "MCP-Protocol-Version": "2026-07-28"}, discover)
        assert status == 200, (status, raw)
        response = json.loads(raw)
        assert "2026-07-28" in response["result"]["supportedVersions"], response
        status, raw = request({"Authorization": f"Bearer {token}", "MCP-Protocol-Version": "2026-07-28"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": metadata}})
        assert status == 200 and json.loads(raw)["result"]["tools"], (status, raw)
        status, raw = request({"Authorization": f"Bearer {token}", "MCP-Protocol-Version": "2026-07-28"}, {"jsonrpc":"2.0","id":3,"method":"prompts/list","params":{"_meta":metadata}})
        assert status == 200 and len(json.loads(raw)["result"]["prompts"]) == 3, (status,raw)
        status, raw = request({"Authorization": f"Bearer {token}", "MCP-Protocol-Version": "2026-07-28", "Mcp-Name":"sigpilot_diagnose_trigger"}, {"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"_meta":metadata,"name":"sigpilot_diagnose_trigger","arguments":{"session_id":"fixture","objective":"D0 rising then D1 pulse"}}})
        assert status == 200 and json.loads(raw)["result"]["messages"], (status,raw)
        print(json.dumps({"transport": "HTTP", "protocol": "2026-07-28", "discovery": "passed", "authentication": "passed", "origin_validation": "passed"}))
    finally:
        process.terminate()
        process.wait(timeout=5)
        log.close()


def decode_exercise(client, root):
    capability = tool(client, "sigpilot_list_capabilities", {})["decoder"]
    if not capability["configured"]:
        print(json.dumps({"native_decode": "unavailable; domain tests use supervised fixtures"}))
        return
    cases = json.loads(Path("testdata/decoders/sigrok-native-conformance-v1.json").read_text())["cases"]
    spi = json.loads(Path("testdata/decoders/spi-conformance-v1.json").read_text())["cases"][0]
    for index, case in enumerate([*cases[:2], spi]):
        path = root / f"native-{index}.pxl"
        count = case["sample_count"]
        metadata = {"version": 1, "source_device": "native-fixture", "sample_rate_hz": case["sample_rate_hz"],
                    "channel_count": case["channel_count"], "enabled_channels": list(range(case["channel_count"])),
                    "unitsize": 1, "sample_count": count, "captured_at": "2026-11-12T00:00:00Z", "labels": []}
        channels = [{"channel": edge["channel"], "initial_high": bool(case["initial_levels"][edge["channel"]]),
                     "transitions_file": f"capture/d{edge['channel']}.u64"} for edge in case["edges"]]
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("project.json", json.dumps({"format": "pxlogic.project.v1", "session": {"name": "native fixture", "notes": "", "analyzers": []},
                "capture": {"kind": "sparse", "metadata": metadata, "channels": channels}}))
            for edge in case["edges"]:
                archive.writestr(f"capture/d{edge['channel']}.u64", b"".join(struct.pack("<Q", s) for s in edge["samples"]))
        opened = tool(client, "sigpilot_open_capture", {"session_id": f"native-{index}", "path": str(path)})
        capture = {k: opened[k] for k in ("session_id", "capture_id", "data_revision")}
        config = [{"protocol": "UART", "settings": {"channel": 0, "baud_rate": "100000"}},
                  {"protocol": "I2C", "settings": {"sda_channel": 1, "scl_channel": 0}},
                  {"protocol": "SPI", "settings": {"mosi_channel": 0, "miso_channel": 1, "clock_channel": 2, "enable_channel": 3}}][index]
        request = {"capture": capture, "range": {"start_sample": "0", "end_sample": str(count)}, "config": config,
                   "request_id": f"native-decode-{index}"}
        create = {"capture":capture,"expected_config_revision":"0","request_id":f"native-config-{index}",
                  "operation":{"op":"create","id":f"native-analyzer-{index}","name":config["protocol"],"config":config}}
        assert tool(client,"sigpilot_configure_analyzer",create)["config_revision"] == "1"
        request.pop("config")
        request.update({"analyzer_id":f"native-analyzer-{index}","expected_config_revision":"1"})
        submitted = tool(client, "sigpilot_run_decode", request)
        assert tool(client, "sigpilot_run_decode", request)["job_id"] == submitted["job_id"]
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            job = tool(client, "sigpilot_get_job", {"job_id": submitted["job_id"]})
            if job["state"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(0.01)
        assert job["state"] == "completed", job
        assert job["result"]["configuration"]["config"]["protocol"] == config["protocol"]
        assert job["result"]["configuration"]["analyzer"]["config_revision"] == "1"
        delete = {"capture":capture,"expected_config_revision":"1","request_id":f"native-config-delete-{index}",
                  "operation":{"op":"delete","id":f"native-analyzer-{index}"}}
        tool(client,"sigpilot_configure_analyzer",delete)
        assert tool(client,"sigpilot_run_decode",request)["job_id"] == submitted["job_id"]
        tool(client,"sigpilot_run_decode",{**request,"request_id":f"native-stale-{index}"},expect_error="VERSION_CONFLICT")
        assert job["capture_current"] is True
        result_id = job["result"]["result_set_id"]
        keep={"capture":capture,"expected_result_revision":"0","request_id":f"retain-{index}","operation":{"op":"retain","job_id":result_id}}
        assert tool(client,"sigpilot_apply_results",{**keep,"preview":True})["result_revision"]=="0"
        retained=tool(client,"sigpilot_apply_results",keep)
        assert tool(client,"sigpilot_apply_results",keep)==retained
        assert tool(client,"sigpilot_get_results",{"capture":capture,"result_revision":"1"})["items"][0]["result_set_id"]==result_id
        stored=tool(client,"sigpilot_get_results",{"capture":capture,"result_set_id":result_id})
        assert stored["verification"]=="runtime_computed" and stored["output"]["frame_count"]==job["result"]["frame_count"]
        chunks="";offset="0"
        while True:
            chunk=tool(client,"sigpilot_get_results",{"capture":capture,"result_set_id":result_id,"offset":offset,"max_bytes":1024})
            chunks+=chunk["content"]
            if chunk["complete"]:break
            offset=chunk["next_offset"]
        assert json.loads(chunks)["kind"]=="decode"
        resource_root=f"sigpilot://sessions/{capture['session_id']}/captures/{capture['capture_id']}/{capture['data_revision']}/"
        resource=client.call("resources/read",{"uri":resource_root+f"results/{result_id}"})["result"]
        assert json.loads(resource["contents"][0]["text"])["result_set_id"]==result_id
        field = ["data", "address", "mosi"][index]
        schema = next(s for s in job["result"]["field_schema"] if s["name"] == field)
        assert len(schema["types"]) == 1, schema
        field_type = schema["types"][0]
        assert field_type in ("unsigned", "bytes"), schema
        numeric_value = [165, 80, 165][index]
        value = str(numeric_value) if field_type == "unsigned" else [numeric_value]
        found = tool(client, "sigpilot_query_frames", {"result_set_id": result_id, "query": {
            "fields": [{"name": field, "op": "eq", "value": {"type": field_type, "value": value}}]}})
        assert found["items"], {"query": field, "job": job}
        assert all(f["fields"][field]["value"] == value for f in found["items"])
        assert all(int(f["range"]["end_sample"]) > int(f["range"]["start_sample"]) for f in found["items"])
        proof = tool(client, "sigpilot_get_evidence", {"capture": capture, "refs": [found["items"][0]["evidence_ref"]]})
        assert proof["evidence"][0]["observed"]["fields"][field]["value"] == value
        sequence_query = {"schema_version": "1", "steps": [{"query": {
            "fields": [{"name": field, "op": "eq", "value": {"type": field_type, "value": value}}]}}]}
        sequence = tool(client, "sigpilot_query_frame_sequence", {"result_set_id": result_id, "query": sequence_query})
        assert sequence["search_complete"] is True and sequence["items"]
        assert sequence["items"][0]["frames"][0]["frame_ref"] == found["items"][0]["frame_ref"]
        sequence_proof = tool(client, "sigpilot_get_evidence", {"capture": capture, "refs": [sequence["items"][0]["evidence_ref"]]})
        stored_query = sequence_proof["evidence"][0]["parameters"]["query"]
        assert stored_query["schema_version"] == "1" and stored_query["scope"] == "stream"
        assert stored_query["steps"][0]["query"]["fields"] == sequence_query["steps"][0]["query"]["fields"]
        correlation_request = {"result_set_id": result_id, "channel": [0, 1, 0][index], "start_sample": "0", "limit": 1,
            "query": {"events": sequence_query["steps"][0]["query"], "original_range": {"start_sample": "0", "end_sample": str(count)},
                      "before_samples": str(count), "after_samples": str(count), "min_width_samples": "1", "max_width_exclusive": str(count + 1)}}
        correlations = tool(client, "sigpilot_correlate_pulses", correlation_request)
        assert correlations["items"] and correlations["selected_events"] != "0"
        pair = correlations["items"][0]
        assert int(pair["delta_samples"]) == int(pair["pulse"]["range"]["start_sample"]) - int(pair["frame"]["range"]["start_sample"])
        pair_proof = tool(client, "sigpilot_get_evidence", {"capture": capture, "refs": pair["evidence_refs"]})
        assert pair_proof["evidence"][0]["observed"]["frame_id"] == pair["frame"]["frame_id"]
        assert pair_proof["evidence"][1]["observed"]["range"] == pair["pulse"]["range"]
        assert correlations["interpretation"] == "temporal_cooccurrence"
        if correlations["next_cursor"]:
            next_pair = tool(client, "sigpilot_correlate_pulses", {**correlation_request, "cursor": correlations["next_cursor"]})["items"][0]
            assert (next_pair["pulse"]["range"], next_pair["frame"]["frame_id"]) != (pair["pulse"]["range"], pair["frame"]["frame_id"])
            tool(client, "sigpilot_correlate_pulses", {**correlation_request, "start_sample": "1", "cursor": correlations["next_cursor"]}, expect_error="INVALID_INPUT")
        if index == 1:
            ack_schema = next(s for s in job["result"]["field_schema"] if s["name"] == "ack")
            assert ack_schema["types"] == ["boolean"], ack_schema
            conditions = [sequence_query["steps"][0]["query"], {"fields": [{"name": "ack", "op": "exists"}]}]
            transactions = tool(client, "sigpilot_query_transactions", {"result_set_id": result_id,
                "query": {"conditions": conditions, "require_complete": True}})
            assert transactions["items"] and transactions["filter_scope"] == "same_i2c_segment"
            assert transactions["items"][0]["transaction"]["complete"] is True
            assert transactions["items"][0]["condition_frames"][0]["fields"]["address"]["value"] == "80"
            tool(client, "sigpilot_query_frame_sequence", {"result_set_id": result_id, "query": {"schema_version": "1",
                "scope": "i2c_segment", "steps": [{"query": conditions[0]}, {"query": {"rows": ["data"]},
                "within": {"min_samples": "0", "max_samples": str(count)}}]}})
        else:
            tool(client, "sigpilot_query_transactions", {"result_set_id": result_id}, expect_error="INVALID_INPUT")
        tool(client, "sigpilot_query_frames", {"result_set_id": result_id, "query": {"fields": [
            {"name": "invented", "op": "exists"}]}}, expect_error="INVALID_INPUT")
        tool(client, "sigpilot_query_frames", {"result_set_id": result_id, "query": {"fields": [
            {"name": field, "op": "eq", "value": {"type": "boolean", "value": False}}]}}, expect_error="INVALID_INPUT")
        assert tool(client, "sigpilot_cancel_job", {"job_id": submitted["job_id"]})["state"] == "completed"
        print(json.dumps({"native_decode": config["protocol"], "typed_fields": "passed", "job_replay": "passed",
                          "frames": job["result"]["frame_count"]}))
    i2c_context_exercise(client, root)


def i2c_context_fixture(path, missing_ack, idle_noise=False):
    edges = [[], []]
    levels = [True, True]
    tick = 20

    def set_level(channel, sample, high):
        if levels[channel] != high:
            edges[channel].append(sample)
            levels[channel] = high

    def byte(value, ack):
        nonlocal tick
        for bit in range(7, -1, -1):
            set_level(1, tick + 5, bool(value & (1 << bit)))
            set_level(0, tick + 10, True)
            set_level(0, tick + 20, False)
            tick += 30
        if ack is not None:
            set_level(1, tick + 5, not ack)
            set_level(0, tick + 10, True)
            set_level(0, tick + 20, False)
            tick += 30

    set_level(1, 10, False)
    set_level(0, 20, False)
    byte(0xA0, True)
    pulse_start = None
    if missing_ack:
        byte(0x00, None)
        # A recorded one-sample SDA excursion during the ninth clock creates
        # native STOP/START events and a typed missing-ACK error, rather than
        # attaching an invented error label to a valid decoded frame.
        set_level(0, tick + 10, True)
        pulse_start = tick + 11
        set_level(1, pulse_start, True)
        set_level(1, tick + 12, False)
        set_level(0, tick + 20, False)
        tick += 30
    else:
        byte(0xA5, True)
        set_level(1, tick + 5, True)
        set_level(0, tick + 10, True)
        set_level(1, tick + 15, False)
        set_level(0, tick + 20, False)
        tick += 30
        byte(0xA2, True)
        byte(0x5A, False)
    set_level(1, tick + 5, False)
    set_level(0, tick + 10, True)
    set_level(1, tick + 20, True)
    if idle_noise:
        set_level(1,tick+40,False)
        set_level(1,tick+41,True)
    count = tick + 60
    metadata = {"version": 1, "source_device": "offline-i2c-context-fixture", "sample_rate_hz": 1_000_000,
        "channel_count": 2, "enabled_channels": [0, 1], "unitsize": 1, "sample_count": count,
        "captured_at": "2026-11-12T00:00:00Z", "labels": []}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("project.json", json.dumps({"format": "pxlogic.project.v1", "session": {"name": "I2C context fixture", "notes": "", "analyzers": []},
            "capture": {"kind": "sparse", "metadata": metadata, "channels": [{"channel": c, "initial_high": True,
                "transitions_file": f"capture/d{c}.u64"} for c in range(2)]}}))
        for channel, samples in enumerate(edges):
            archive.writestr(f"capture/d{channel}.u64", b"".join(struct.pack("<Q", s) for s in samples))
    return count, pulse_start


def i2c_context_exercise(client, root):
    def decode(capture, count, request_id, start=0):
        submitted = tool(client, "sigpilot_run_decode", {"capture": capture,
            "range": {"start_sample": str(start), "end_sample": str(count)},
            "config": {"protocol": "I2C", "settings": {"sda_channel": 1, "scl_channel": 0}}, "request_id": request_id})
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            job = tool(client, "sigpilot_get_job", {"job_id": submitted["job_id"]})
            if job["state"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(0.01)
        assert job["state"] == "completed", job
        return job

    def address(value):
        return {"fields": [{"name": "address", "op": "eq", "value": {"type": "unsigned", "value": str(value)}}]}

    nack = {"fields": [{"name": "ack", "op": "eq", "value": {"type": "boolean", "value": False}}]}
    for missing_ack in (False, True):
        session_id = "native-i2c-error" if missing_ack else "native-i2c-restart"
        path = root / f"{session_id}.pxl"
        count, pulse_start = i2c_context_fixture(path, missing_ack)
        opened = tool(client, "sigpilot_open_capture", {"session_id": session_id, "path": str(path)})
        capture = {k: opened[k] for k in ("session_id", "capture_id", "data_revision")}
        job = decode(capture, count, session_id)
        result_id = job["result"]["result_set_id"]
        if missing_ack:
            error_schema = next(s for s in job["result"]["field_schema"] if s["name"] == "error")
            assert error_schema["types"] == ["text"], error_schema
            events = {"fields": [{"name": "error", "op": "exists"}]}
            errors = tool(client, "sigpilot_query_frames", {"result_set_id": result_id, "query": events})
            assert errors["items"] and all("ack" not in f["fields"] for f in errors["items"])
            assert not tool(client, "sigpilot_query_frames", {"result_set_id": result_id,
                "query": {"fields": [*events["fields"], *nack["fields"]]}})["items"]
            correlated = tool(client, "sigpilot_correlate_pulses", {"result_set_id": result_id, "channel": 1, "start_sample": "0",
                "query": {"events": events, "original_range": {"start_sample": "0", "end_sample": str(count)},
                    "before_samples": "0", "after_samples": str(count), "high": True,
                    "min_width_samples": "1", "max_width_exclusive": "3"}})
            assert correlated["complete"] is True and len(correlated["items"]) == 1, correlated
            pair = correlated["items"][0]
            assert pair["pulse"]["range"] == {"start_sample": str(pulse_start), "end_sample": str(pulse_start + 1)}
            assert pair["pulse"]["width_samples"] == "1" and "error" in pair["frame"]["fields"]
            proof = tool(client, "sigpilot_get_evidence", {"capture": capture, "refs": pair["evidence_refs"]})
            assert len(proof["evidence"]) == 2
            derived=tool(client,"sigpilot_create_derived_capture",{"capture":capture,"target_session_id":"filtered-i2c-error","channels":[1],"max_width_exclusive":"2","high":True,"request_id":"filter-i2c-error"})["context"]
            filtered_capture={k:derived[k] for k in ("session_id","capture_id","data_revision")}
            assert derived["derivation"]["modifications"][1]["replaced_pulses"]=="1"
            filtered=decode(filtered_capture,count,"filtered-i2c-error")
            # This fixture's one-sample STOP/START excursion causes the error.
            # The derived decoder does not declare an observed error field;
            # never reuse a schema from the original result in a new decode.
            assert not any(f["name"]=="error" for f in filtered["result"]["field_schema"])
            filtered_frames=tool(client,"sigpilot_query_frames",{"result_set_id":filtered["result"]["result_set_id"]})
            assert filtered_frames["items"] and filtered_frames["capture"]==filtered_capture
            after=tool(client,"sigpilot_query_frames",{"result_set_id":result_id,"query":events})
            assert [(f["range"],f["fields"]) for f in after["items"]]==[(f["range"],f["fields"]) for f in errors["items"]]
            print(json.dumps({"native_original_derived_redecode":"passed","pulse_induced_decode_error_removed":"passed"}))
            print(json.dumps({"native_i2c_error_and_one_sample_pulse": "passed", "missing_ack_is_not_nack": "passed"}))
        else:
            query = {"conditions": [address(80), nack], "require_complete": True}
            assert not tool(client, "sigpilot_query_transactions", {"result_set_id": result_id, "query": query})["items"]
            query["conditions"][0] = address(81)
            matches = tool(client, "sigpilot_query_transactions", {"result_set_id": result_id, "query": query})["items"]
            assert len(matches) == 1 and matches[0]["transaction"]["segment_count"] == "2", matches
            sequence = {"schema_version": "1", "steps": [{"query": address(80)}, {"query": nack}]}
            assert tool(client, "sigpilot_query_frame_sequence", {"result_set_id": result_id, "query": sequence})["items"]
            assert not tool(client, "sigpilot_query_frame_sequence", {"result_set_id": result_id, "query": {**sequence, "scope": "i2c_segment"}})["items"]
            data_start = int(matches[0]["condition_frames"][1]["range"]["start_sample"])
            prefix = decode(capture, count, "restart-prefix", data_start)
            prefix_matches = tool(client, "sigpilot_query_transactions", {"result_set_id": prefix["result"]["result_set_id"], "query": query})["items"]
            assert len(prefix_matches) == 1
            assert int(prefix_matches[0]["condition_frames"][0]["range"]["start_sample"]) < data_start
            print(json.dumps({"native_i2c_repeated_start_scope": "passed", "prefix_address_context": "passed"}))
    path=root/"native-i2c-independent.pxl"
    count,_=i2c_context_fixture(path,False,idle_noise=True)
    context=tool(client,"sigpilot_open_capture",{"session_id":"native-i2c-independent","path":str(path)})
    capture={k:context[k] for k in ("session_id","capture_id","data_revision")}
    original=decode(capture,count,"independent-original")
    observed=tool(client,"sigpilot_query_frames",{"result_set_id":original["result"]["result_set_id"],"query":nack})
    assert observed["items"]
    derived=tool(client,"sigpilot_create_derived_capture",{"capture":capture,"target_session_id":"filtered-i2c-independent","channels":[1],"max_width_exclusive":"2","high":False,"request_id":"filter-independent"})["context"]
    filtered_capture={k:derived[k] for k in ("session_id","capture_id","data_revision")}
    filtered=decode(filtered_capture,count,"independent-filtered")
    still=tool(client,"sigpilot_query_frames",{"result_set_id":filtered["result"]["result_set_id"],"query":nack})
    assert [(f["range"],f["fields"]) for f in still["items"]]==[(f["range"],f["fields"]) for f in observed["items"]]
    print(json.dumps({"independent_observed_nack_survives_filter":"passed"}))



def main():
    if platform.system() != "Linux" or "instabox" not in platform.release():
        raise SystemExit("MCP runtime verification is restricted to Instabox")
    binary = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix="sigpilot-mcp-wire-") as directory:
        root = Path(directory)
        fixture(root / "capture.pxl")
        client = Stdio(binary, root)
        try: exercise(client, root)
        finally: client.close()
        http_check(binary, root)


if __name__ == "__main__":
    main()
