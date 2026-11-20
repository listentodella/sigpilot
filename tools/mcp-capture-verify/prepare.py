#!/usr/bin/env python3
"""Prepare explicit local-desktop verification assets; never starts captures."""
import argparse
import json
from pathlib import Path
import shlex


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:10531/mcp")
    parser.add_argument("--name", default="sigpilot-capture-test")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-hardware", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = (args.output or root / ".verification/mcp-capture").resolve()
    output.mkdir(parents=True, exist_ok=True)
    command = ["python3", str(Path(__file__).with_name("run_codex.py")),
               "--endpoint", args.endpoint, "--name", args.name,
               "--output", str(output), "--workspace", str(root)]
    if args.allow_hardware:
        command.append("--allow-hardware")
    config = {"endpoint": args.endpoint, "name": args.name,
              "output": str(output), "command": shlex.join(command),
              "allowHardware": args.allow_hardware}
    script = "globalThis.__SIGPILOT_CAPTURE_VERIFY__ = " + json.dumps(config) + ";\n"
    script += Path(__file__).with_name("bootstrap.js").read_text()
    path = output / "desktop-verify.js"
    path.write_text(script)
    print(json.dumps({"script": str(path), "output": str(output),
                      "allow_hardware": args.allow_hardware}))


if __name__ == "__main__":
    main()
