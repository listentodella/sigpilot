#!/usr/bin/env python3
"""Real Demo / generated stdio config / shared-service UI integration on Instabox."""
from html import unescape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request
if platform.system()!='Linux' or 'instabox' not in platform.release():
 raise SystemExit('onboarding verification is restricted to Instabox')
subprocess.run(['/usr/local/bin/node','node_modules/vite/bin/vite.js','build','--config','tools/mcp-onboarding-verify/vite.config.ts'],check=True)
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0));backend_port=sock.getsockname()[1]
fixture=tempfile.TemporaryDirectory(prefix='Demo 连接 "onboarding"-',dir='.verification')
backend=subprocess.Popen(['target/debug/examples/onboarding_gui_fixture',str(backend_port),fixture.name],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
class Handler(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/fixture/setup':self.proxy('setup')
  else:super().do_GET()
 def do_POST(self):
  if self.path not in ('/fixture/configure','/fixture/check','/fixture/snapshot','/fixture/mark','/fixture/reopen','/fixture/authorization','/fixture/decide','/fixture/revoke','/fixture/begin-authorization'):self.send_error(404);return
  self.proxy(self.path.rsplit('/',1)[1])
 def proxy(self,path):
  size=int(self.headers.get('Content-Length',0))
  if size>240*1024:self.send_error(413);return
  body=self.rfile.read(size) if self.command=='POST' else None
  request=urllib.request.Request(f'http://127.0.0.1:{backend_port}/{path}',data=body,headers={'Content-Type':'application/json'},method=self.command)
  try:
   with urllib.request.urlopen(request,timeout=25) as response:status=response.status;content=response.read(256*1024)
  except urllib.error.HTTPError as error:status=error.code;content=error.read(256*1024)
  self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 for n in range(80):
  if backend.poll() is not None:raise RuntimeError(backend.stderr.read(4000).decode())
  try:
   with socket.create_connection(('127.0.0.1',backend_port),timeout=0.1):break
  except OSError:time.sleep(0.1)
 with urllib.request.urlopen(f'http://127.0.0.1:{backend_port}/setup',timeout=5) as response:
  setup=json.load(response)
 for config in setup['configurations']:
  parsed=tomllib.loads(config['content']) if config['format']=='toml' else json.loads(config['content'])
  entry=parsed['mcp_servers' if config['format']=='toml' else 'mcpServers']['sigpilot']
  assert entry['url']==setup['endpoint'] and 'command' not in entry and 'headers' not in entry
  if config.get('registration_command'):
   import shlex
   argv=shlex.split(config['registration_command'])
   assert argv==(['codex','mcp','add','sigpilot','--url',setup['endpoint']] if config['id']=='codex' else ['claude','mcp','add','--transport','http','--scope','user','sigpilot',setup['endpoint']])
  if config.get('install_uri'):
   import base64,urllib.parse
   url=urllib.parse.urlsplit(config['install_uri']);query=urllib.parse.parse_qs(url.query)
   assert url.scheme=='cursor' and query['name']==['sigpilot']
   assert json.loads(base64.b64decode(query['config'][0]))==entry
 screenshot=Path('.verification/onboarding.png').resolve()
 result=subprocess.run(['/usr/bin/chromium','--headless=new','--no-sandbox','--no-zygote','--disable-gpu','--disable-dev-shm-usage','--renderer-process-limit=1',
  '--window-size=1024,1600','--virtual-time-budget=30000',f'--screenshot={screenshot}','--dump-dom',f'http://127.0.0.1:{server.server_port}/tools/mcp-onboarding-verify/check.html'],capture_output=True,text=True,timeout=60,check=True)
 match=re.search(r'<pre id="out">(.*?)</pre>',result.stdout,re.S)
 report=json.loads(unescape(match[1])) if match else {'passed':False,'error':'fixture result missing'}
 Path('.verification/onboarding-report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report));sys.exit(0 if report['passed'] else 1)
finally:
 server.shutdown();server.server_close();backend.terminate();backend.wait(timeout=3);fixture.cleanup()
