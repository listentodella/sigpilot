#!/usr/bin/env python3
"""Run verification only inside Instabox, with a hard cgroup and disk guard."""

import argparse
import json
import os
from pathlib import Path
import platform
import pwd
import shutil
import subprocess
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--cwd", required=True, type=Path)
    parser.add_argument("--memory-mib", type=int, default=2048)
    parser.add_argument("--cpu-percent", type=int, default=100)
    parser.add_argument("--timeout", type=int, default=540)
    parser.add_argument("--reserve-disk-mib", type=int, default=1536)
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if platform.system() != "Linux" or "instabox" not in platform.release():
        parser.error("verification is restricted to Instabox; local execution is disabled")
    argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    if not argv or not 1 <= args.cpu_percent <= 100 or not 256 <= args.memory_mib <= 2048 or not 1 <= args.timeout <= 540:
        parser.error("expected argv, CPU <= 100%, memory <= 2048 MiB, and timeout <= 540s")
    if args.reserve_disk_mib < 1024:
        parser.error("at least 1024 MiB of disk must remain available")
    args.cwd = args.cwd.resolve(strict=True)
    if not str(args.cwd).startswith("/data/workspace/sigpilot-mcp"):
        parser.error("work directory must belong to the isolated SigPilot MCP workspace")
    available = next(int(line.split()[1]) for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:")) * 1024
    if available < (args.memory_mib + 768) * 1024**2:
        raise RuntimeError("insufficient memory reserve; no verification process was started")
    if shutil.disk_usage(args.cwd).free < (args.reserve_disk_mib + 256) * 1024**2:
        raise RuntimeError("insufficient disk reserve; no verification process was started")
    if subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode:
        raise RuntimeError("cgroup access unavailable; refusing an unbounded run")
    run_id = uuid.uuid4().hex[:12]
    unit = f"sigpilot-mcp-{run_id}"
    root = args.cwd / ".verification"
    root.mkdir(exist_ok=True)
    state_file = root / f"{run_id}.json"
    log_file = root / f"{run_id}.log"
    state = {"run_id": run_id, "label": args.label, "unit": unit, "command": argv,
             "memory_limit_mib": args.memory_mib, "cpu_percent": args.cpu_percent,
             "timeout_seconds": args.timeout, "log": str(log_file), "status": "starting"}

    def save():
        temporary = state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(state_file)

    save()
    command = ["sudo", "-n", "systemd-run", "--wait", "--pipe", "--collect",
               f"--unit={unit}", f"--uid={pwd.getpwuid(os.getuid()).pw_name}",
               f"--working-directory={args.cwd}",
               f"--property=MemoryMax={args.memory_mib * 1024**2}",
               "--property=MemorySwapMax=0", f"--property=CPUQuota={args.cpu_percent}%",
               "--property=TasksMax=128", f"--property=RuntimeMaxSec={args.timeout}",
               "--property=Nice=10", "/usr/bin/flock", "--nonblock",
               "/data/workspace/.sigpilot-mcp-verification.lock", "/usr/bin/env",
               "CARGO_BUILD_JOBS=1", "CARGO_PROFILE_DEV_DEBUG=0", "CARGO_PROFILE_TEST_DEBUG=0",
               "CARGO_INCREMENTAL=0",
               "RAYON_NUM_THREADS=1", "SIGPILOT_PREBUILT_NATIVE=1", "PYTHONDONTWRITEBYTECODE=1",
               *argv]
    reason = None
    with log_file.open("wb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        state.update(status="running", observer_pid=process.pid)
        save()
        while process.poll() is None:
            if shutil.disk_usage(args.cwd).free < args.reserve_disk_mib * 1024**2:
                reason = "disk_reserve_reached"
                subprocess.run(["sudo", "-n", "systemctl", "stop", unit], capture_output=True, timeout=20)
                break
            time.sleep(1)
        result = process.wait(timeout=30)
    # systemd-run can return zero for a unit explicitly stopped by the disk
    # observer. A resource stop is a failed verification, never a passed check.
    if reason is not None and result == 0:
        result = 125
    state.update(status="completed" if result == 0 else "failed", exit_code=result, stop_reason=reason)
    save()
    print(json.dumps(state), flush=True)
    with log_file.open("rb") as log:
        log.seek(max(0, log_file.stat().st_size - 12 * 1024))
        print(log.read().decode("utf-8", "replace"))
    return result


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(125)
