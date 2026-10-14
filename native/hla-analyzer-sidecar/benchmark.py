#!/usr/bin/env python3
"""Bounded-memory end-to-end benchmark; consumes one response per batch."""
import argparse
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time

HOST = Path(__file__).resolve().parent
MANIFEST = HOST.parents[1] / 'testdata/hla/original/extension.json'


def rss_bytes(usage):
    return usage.ru_maxrss if sys.platform == 'darwin' else usage.ru_maxrss * 1024


def measure(count, batch_size):
    start = time.perf_counter()
    proc = subprocess.Popen([sys.executable, '-I', str(HOST / 'main.py')],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    sent, received, roundtrip = 0, 0, 0.0

    def exchange(request):
        nonlocal sent, received, roundtrip
        wire = (json.dumps(request, separators=(',', ':')) + '\n').encode()
        sent += len(wire)
        before = time.perf_counter()
        proc.stdin.write(wire)
        proc.stdin.flush()
        reply = proc.stdout.readline()
        roundtrip += time.perf_counter() - before
        received += len(reply)
        if not reply:
            raise RuntimeError('sidecar closed its output')
        response = json.loads(reply)
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response

    try:
        ready = exchange({'op': 'start', 'manifest_path': str(MANIFEST),
                          'entry_point': 'fixture.Echo', 'settings': {}, 'sample_rate_hz': 1000000})
        if ready != {'ready': True}:
            raise RuntimeError('invalid start response')
        startup = time.perf_counter() - start
        roundtrip = 0.0
        processing_start = time.perf_counter()
        for offset in range(0, count, batch_size):
            length = min(batch_size, count - offset)
            frames = [{'type': 'data', 'start_sample': i, 'end_sample': i+1,
                       'data': {'value': {'Unsigned': i}}} for i in range(offset, offset + length)]
            response = exchange({'op': 'batch', 'frames': frames})
            if len(response.get('frames', [])) != length:
                raise RuntimeError('frame count mismatch')
            del response, frames
        processing = time.perf_counter() - processing_start
        batch_roundtrip = roundtrip
        if exchange({'op': 'finish'}) != {'done': True}:
            raise RuntimeError('invalid finish response')
        proc.stdin.close()
        _, status, usage = os.wait4(proc.pid, 0)
        proc.returncode = os.waitstatus_to_exitcode(status)
        if proc.returncode:
            raise RuntimeError(f'sidecar exited {proc.returncode}')
        return {'frames': count, 'batch_size': batch_size, 'startup_seconds': round(startup, 6),
                'processing_seconds': round(processing, 6),
                'frames_per_second': round(count / processing),
                'batch_roundtrip_seconds': round(batch_roundtrip, 6),
                'sidecar_cpu_seconds': round(usage.ru_utime + usage.ru_stime, 6),
                'sidecar_peak_rss_bytes': rss_bytes(usage),
                'driver_peak_rss_bytes_cumulative': rss_bytes(resource.getrusage(resource.RUSAGE_SELF)),
                'ipc_sent_bytes': sent, 'ipc_received_bytes': received}
    finally:
        if proc.returncode is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        if not proc.stdin.closed:
            proc.stdin.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--counts', nargs='+', type=int, default=[10000, 100000, 1000000])
    parser.add_argument('--batch-size', type=int, default=1000)
    args = parser.parse_args()
    if args.batch_size < 1 or any(n < 1 for n in args.counts):
        parser.error('counts and batch size must be positive')
    for count in args.counts:
        print(json.dumps(measure(count, args.batch_size)), flush=True)


if __name__ == '__main__':
    main()
