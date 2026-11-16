#!/usr/bin/env python3
"""Instabox-only real dialog/shared-service fixture, under limited-run.py."""
from html import unescape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

if platform.system()!='Linux' or 'instabox' not in platform.release():
    raise SystemExit('GUI fixture is restricted to Instabox')
subprocess.run(['/usr/local/bin/node','node_modules/vite/bin/vite.js','build','--config','tools/mcp-analyzers-verify/vite.config.ts'],check=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0))
    backend_port=sock.getsockname()[1]
backend=subprocess.Popen(['target/debug/examples/analyzer_gui_fixture',str(backend_port)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path=='/fixture/snapshot':self.proxy('snapshot')
        else:super().do_GET()
    def do_POST(self):
        if self.path not in ('/fixture/replace','/fixture/mcp'):
            self.send_error(404);return
        self.proxy(self.path.rsplit('/',1)[1])
    def proxy(self,path):
        size=int(self.headers.get('Content-Length',0))
        if size>240*1024:self.send_error(413);return
        body=self.rfile.read(size) if self.command=='POST' else None
        headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
        if path=='mcp':
            headers.update({'Authorization':'Bearer sigpilot-gui-fixture-token-0123456789','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'sigpilot_configure_analyzer'})
        request=urllib.request.Request(f'http://127.0.0.1:{backend_port}/{path}',data=body,headers=headers,method=self.command)
        try:
            with urllib.request.urlopen(request,timeout=10) as response:
                status=response.status;content=response.read(256*1024)
        except urllib.error.HTTPError as error:
            status=error.code;content=error.read(256*1024)
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        if backend.poll() is not None:raise RuntimeError(backend.stderr.read(4000).decode())
        try:
            with socket.create_connection(('127.0.0.1',backend_port),timeout=0.1):break
        except OSError:time.sleep(0.1)
    result=subprocess.run(['/usr/bin/chromium','--headless=new','--no-sandbox','--no-zygote','--disable-gpu','--disable-dev-shm-usage','--renderer-process-limit=1',
        '--virtual-time-budget=12000','--dump-dom',f'http://127.0.0.1:{server.server_port}/tools/mcp-analyzers-verify/check.html'],capture_output=True,text=True,timeout=40,check=True)
    match=re.search(r'<pre id="out">(.*?)</pre>',result.stdout,re.S)
    report=json.loads(unescape(match[1])) if match else {'passed':False,'error':'fixture result missing'}
    print(json.dumps(report));sys.exit(0 if report['passed'] else 1)
finally:
    server.shutdown();server.server_close();backend.terminate();backend.wait(timeout=3)
