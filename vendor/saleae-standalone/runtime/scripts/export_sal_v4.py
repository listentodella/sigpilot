#!/usr/bin/env python3
"""Convert current Logic 2 .sal files to the runtime's sparse public manifest."""

import argparse
import json
import pathlib
import struct
import zipfile

from saleae import automation


def find_sample_rate(value):
    if isinstance(value, dict):
        rate = value.get("sampleRate")
        if isinstance(rate, dict) and isinstance(rate.get("digital"), int):
            return rate["digital"]
        for child in value.values():
            found = find_sample_rate(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_sample_rate(child)
            if found:
                return found
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--logic", required=True, type=pathlib.Path)
    parser.add_argument("--port", type=int, default=10430)
    args = parser.parse_args()

    source = args.input.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        meta = json.loads(archive.read("meta.json"))
    data = meta["data"]
    enabled = sorted(
        item["deviceChannel"]
        for item in meta.get("binData", [])
        if item.get("type") == "Digital"
    )
    if not enabled:
        raise RuntimeError("capture contains no digital channels")

    raw = output / "automation-export"
    raw.mkdir(exist_ok=True)
    with automation.Manager.launch(
        args.logic.resolve(), connect_timeout_seconds=30, port=args.port
    ) as manager:
        capture = manager.load_capture(str(source))
        capture.export_raw_data_binary(str(raw), digital_channels=enabled)
        capture.close()

    channels = []
    duration = 0.0
    for channel in enabled:
        exported = raw / f"digital_{channel}.bin"
        target = output / f"digital-{channel}.bin"
        payload = exported.read_bytes()
        duration = max(duration, struct.unpack_from("<d", payload, 28)[0])
        target.write_bytes(payload)
        channels.append({"channel": channel, "file": target.name})

    sample_rate = find_sample_rate(data)
    if not sample_rate:
        raise RuntimeError("capture metadata contains no digital sample rate")
    analyzers = [
        {
            "type": item.get("type", ""),
            "name": item.get("name", ""),
            "settings": [
                {"title": setting["title"], "setting": setting["setting"]}
                for setting in item.get("settings", [])
            ],
        }
        for item in data.get("analyzers", [])
    ]
    labels = [row.get("name", "") for row in data.get("rowsSettings", [])]
    manifest = {
        "format": "pxlogic.saleae-transition.v1",
        "source": str(source),
        "sample_rate_hz": sample_rate,
        "channel_count": max(enabled) + 1,
        "duration_seconds": duration,
        "sample_count": round(duration * sample_rate),
        "channels": channels,
        "session": {
            "name": data.get("name", source.stem),
            "notes": data.get("captureNotes", ""),
            "labels": labels,
            "analyzers": analyzers,
        },
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
