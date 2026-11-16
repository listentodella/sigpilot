#!/usr/bin/env python3
"""Prune only replaceable artifacts in this task's isolated Instabox target."""
import fcntl
import argparse
from pathlib import Path
import platform
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--for-desktop-check", action="store_true", help="discard this task's dependency cache after runtime checks, preserving native resources")
args = parser.parse_args()

workspace = Path.cwd().resolve()
if platform.system() != "Linux" or "instabox" not in platform.release() or not str(workspace).startswith("/data/workspace/sigpilot-mcp-"):
    raise SystemExit("cleanup is restricted to the isolated Instabox workspace")
with Path("/data/workspace/.sigpilot-mcp-verification.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    deps = workspace / "target/debug/deps"
    if args.for_desktop_check:
        # Check and test profiles have different feature sets. Release only
        # this isolated task's replaceable cache before the final desktop pass.
        shutil.rmtree(deps, ignore_errors=True)
        print({"removed": "task_dependency_cache", "free_mib": shutil.disk_usage(workspace).free // 1024**2})
        raise SystemExit(0)
    files = {f for f in deps.glob("*.rmeta") if not f.with_suffix(".rlib").exists()}
    for pattern in ("lib*.rlib", "sigpilot_mcp-*", "sigpilot_mcp_bridge-*"):
        groups = {}
        for path in deps.glob(pattern):
            if pattern != "lib*.rlib" and path.suffix:
                continue
            groups.setdefault(path.name.split("-")[0], []).append(path)
        for group in groups.values():
            for old in sorted(group, key=lambda f: f.stat().st_mtime, reverse=True)[1:]:
                files.add(old)
                if old.suffix == ".rlib" and old.with_suffix(".rmeta").exists():
                    files.add(old.with_suffix(".rmeta"))
    # Completed tests can be relinked when new changes justify another run.
    files.update(f for f in deps.iterdir() if f.is_file() and not f.suffix and f.name.startswith(
        ("sigpilot_analysis-", "sigpilot_workbench-", "sigpilot_file-", "sigpilot_graph-", "desktop_bridge-")))
    count = sum(f.stat().st_size for f in files)
    for path in files:
        path.unlink()
    print({"removed_artifact_mib": count // 1024**2, "free_mib": shutil.disk_usage(workspace).free // 1024**2})
