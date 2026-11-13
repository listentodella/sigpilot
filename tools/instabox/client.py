#!/usr/bin/env python3
"""Small stdlib-only transport for resource-limited Instabox verification.

Credentials stay on the caller's machine. Commands use structured argv and are
never automatically retried after an observation failure.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.instabox.sh"


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).netloc != "api.instabox.sh":
            raise RuntimeError("refusing to send credentials to a different origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--machine", required=True)
    parser.add_argument("--key-file", type=Path)
    sub = parser.add_subparsers(dest="action", required=True)
    execution = sub.add_parser("exec")
    execution.add_argument("--cwd")
    execution.add_argument("--timeout", type=int, default=60)
    execution.add_argument("--stdin-file", type=Path)
    execution.add_argument("--env", action="append", default=[])
    execution.add_argument("--result-file", type=Path)
    execution.add_argument("argv", nargs=argparse.REMAINDER)
    upload = sub.add_parser("put")
    upload.add_argument("local", type=Path)
    upload.add_argument("remote")
    download = sub.add_parser("get")
    download.add_argument("remote")
    download.add_argument("local", type=Path)
    download.add_argument("--max-bytes", type=int, default=32 * 1024 * 1024)
    args = parser.parse_args()

    if not re.fullmatch(r"m_[a-z2-7]{26}|[a-z0-9][a-z0-9-]{0,62}", args.machine):
        parser.error("invalid machine reference")
    key = args.key_file.read_text().strip() if args.key_file else os.environ.get("INSTABOX_API_KEY", "")
    if not key:
        parser.error("provide INSTABOX_API_KEY or --key-file")
    opener = urllib.request.build_opener(SameOriginRedirect())

    def request(method, suffix, data=None, content_type=None, length=None, timeout=60):
        headers = {"X-API-Key": key}
        if content_type:
            headers["Content-Type"] = content_type
        if length is not None:
            headers["Content-Length"] = str(length)
        req = urllib.request.Request(f"{API}/v1/machines/{args.machine}/{suffix}", data=data, headers=headers, method=method)
        return opener.open(req, timeout=timeout)

    try:
        if args.action == "exec":
            argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
            if not argv or not 1 <= args.timeout <= 600:
                parser.error("exec requires argv and a timeout between 1 and 600 seconds")
            body = {"argv": argv, "timeoutSeconds": args.timeout}
            if args.cwd:
                body["cwd"] = args.cwd
            if args.stdin_file:
                raw = args.stdin_file.read_bytes()
                if len(raw) > 1024 * 1024:
                    parser.error("stdin exceeds 1 MiB; upload it as a file instead")
                body["stdin"] = raw.decode("utf-8")
            envs = {}
            for item in args.env:
                name, sep, value = item.partition("=")
                if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    parser.error("--env requires NAME=value")
                envs[name] = value
            if envs:
                body["envs"] = envs
            with request("POST", "exec", json.dumps(body).encode(), "application/json", timeout=args.timeout + 20) as response:
                result = json.load(response)
            # Also redact output from an accidental credential echo in a command.
            encoded = json.dumps(result, ensure_ascii=False).replace(key, "[REDACTED]")
            if args.result_file:
                args.result_file.parent.mkdir(parents=True, exist_ok=True)
                args.result_file.write_text(encoded + "\n")
            print(encoded)
            return int(result.get("exitCode", 1))
        if args.action == "put":
            size = args.local.stat().st_size
            query = urllib.parse.urlencode({"path": args.remote, "parents": "true"})
            # File objects are streamed by urllib/http.client in bounded chunks.
            with args.local.open("rb") as source, request("PUT", f"files?{query}", source, "application/octet-stream", size, 120) as response:
                result = json.load(response)
            digest = hashlib.sha256()
            with args.local.open("rb") as source:
                for chunk in iter(lambda: source.read(64 * 1024), b""):
                    digest.update(chunk)
            if result.get("sha256") != digest.hexdigest():
                raise RuntimeError("uploaded file checksum differs")
            print(json.dumps(result))
            return 0
        if args.max_bytes < 1:
            parser.error("--max-bytes must be positive")
        query = urllib.parse.urlencode({"path": args.remote})
        with request("GET", f"files/content?{query}", timeout=120) as response:
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > args.max_bytes:
                raise RuntimeError("download exceeds the configured byte budget")
            args.local.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.local.with_name(args.local.name + ".part")
            count = 0
            try:
                with temporary.open("wb") as target:
                    while chunk := response.read(64 * 1024):
                        count += len(chunk)
                        if count > args.max_bytes:
                            raise RuntimeError("download exceeds the configured byte budget")
                        target.write(chunk)
                if declared and count != int(declared):
                    raise RuntimeError("incomplete download")
                temporary.replace(args.local)
            finally:
                temporary.unlink(missing_ok=True)
        print(json.dumps({"local": str(args.local), "bytes": count}))
        return 0
    except urllib.error.HTTPError as error:
        body = error.read(16 * 1024).decode("utf-8", "replace").replace(key, "[REDACTED]")
        print(json.dumps({"http_status": error.code, "error": body}), file=sys.stderr)
        return 125
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error).replace(key, "[REDACTED]"), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
