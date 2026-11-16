#!/usr/bin/env python3
"""Run this GUI fixture under tools/instabox/limited-run.py on Instabox."""
from html import unescape
import json
from pathlib import Path
import re
import socket
import subprocess
import sys

subprocess.run(['/usr/local/bin/node','node_modules/vite/bin/vite.js','build','--config','tools/mcp-markers-verify/vite.config.ts'],check=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0))
    port=sock.getsockname()[1]
server=subprocess.Popen(['/usr/bin/python3','-m','http.server',str(port),'--bind','127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
    import time
    for _ in range(30):
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=0.1):break
        except OSError:time.sleep(0.1)
    result=subprocess.run(['/usr/bin/chromium','--headless=new','--no-sandbox','--no-zygote','--disable-gpu','--disable-dev-shm-usage','--renderer-process-limit=1',
        '--virtual-time-budget=3000','--dump-dom',f'http://127.0.0.1:{port}/tools/mcp-markers-verify/check.html'],capture_output=True,text=True,timeout=30,check=True)
    match=re.search(r'<pre id="out">(.*?)</pre>',result.stdout,re.S)
    report=json.loads(unescape(match[1])) if match else {'passed':False,'error':'fixture result missing'}
    print(json.dumps(report))
    sys.exit(0 if report['passed'] else 1)
finally:
    server.terminate()
    server.wait(timeout=3)
