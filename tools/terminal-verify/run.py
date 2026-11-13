#!/usr/bin/env python3
"""Chromium interaction checks against the production Rust PTY, on Instabox only."""
import base64
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import platform
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

if platform.system() != 'Linux' or 'instabox' not in platform.release():
    raise SystemExit('terminal verification is restricted to Instabox')
workspace = Path.cwd()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    backend_port = sock.getsockname()[1]
backend = subprocess.Popen(['target/debug/examples/browser_fixture', str(backend_port)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(workspace / 'tools/terminal-verify/dist'), **kwargs)
    def log_message(self, *args): pass
    def do_POST(self):
        if not self.path.startswith('/fixture/'):
            self.send_error(404); return
        size = int(self.headers.get('Content-Length', 0))
        if size > 128 * 1024:
            self.send_error(413); return
        request = urllib.request.Request(f'http://127.0.0.1:{backend_port}/{self.path.rsplit("/", 1)[1]}', data=self.rfile.read(size), headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                code, data = response.status, response.read(300 * 1024)
        except urllib.error.HTTPError as error:
            code, data = error.code, error.read(300 * 1024)
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

class Cdp:
    def __init__(self, url):
        from urllib.parse import urlsplit
        parsed = urlsplit(url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=10)
        self.sock.settimeout(15)
        key = base64.b64encode(b'sigpilotpreview!').decode()
        self.sock.sendall(f'GET {parsed.path} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
        header = b''
        while b'\r\n\r\n' not in header:
            header += self.sock.recv(1)
        if b'101' not in header.split(b'\r\n', 1)[0]: raise RuntimeError(header)
        self.sequence = 0
    def exact(self, count):
        data = b''
        while len(data) < count:
            chunk = self.sock.recv(count-len(data))
            if not chunk: raise RuntimeError('CDP disconnected')
            data += chunk
        return data
    def send(self, data, opcode=1):
        mask = b'\x13\x57\x24\x68'
        length = len(data)
        prefix = bytes([0x80 | opcode, 0x80 | length]) if length < 126 else bytes([0x80 | opcode, 0xfe]) + struct.pack('!H', length) if length < 65536 else bytes([0x80 | opcode, 0xff]) + struct.pack('!Q', length)
        self.sock.sendall(prefix + mask + bytes(byte ^ mask[i % 4] for i, byte in enumerate(data)))
    def recv(self):
        header = self.exact(2)
        opcode, length = header[0] & 15, header[1] & 127
        if length == 126: length = struct.unpack('!H', self.exact(2))[0]
        elif length == 127: length = struct.unpack('!Q', self.exact(8))[0]
        if length > 4 * 1024 * 1024: raise RuntimeError('CDP response exceeds budget')
        data = self.exact(length)
        if opcode == 9: self.send(data, 10); return self.recv()
        if opcode != 1: raise RuntimeError('Unexpected WebSocket opcode')
        return json.loads(data)
    def call(self, method, params=None):
        self.sequence += 1
        request_id = self.sequence
        self.send(json.dumps({'id': request_id, 'method': method, 'params': params or {}}).encode())
        while True:
            response = self.recv()
            if response.get('id') == request_id:
                if 'error' in response: raise RuntimeError(response['error'])
                return response.get('result', {})
    def js(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in result: raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
profile = tempfile.TemporaryDirectory(prefix='sigpilot-terminal-browser-')
browser = subprocess.Popen(['/usr/bin/chromium', '--headless=new', '--no-sandbox', '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage', '--renderer-process-limit=1', '--window-size=1320,840', '--remote-debugging-port=0', '--user-data-dir=' + profile.name, 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
checks = []
try:
    port_file = Path(profile.name) / 'DevToolsActivePort'
    deadline = time.monotonic()+10
    while not port_file.exists():
        if time.monotonic()>deadline: raise RuntimeError('Chromium did not start')
        time.sleep(.05)
    debug_port = int(port_file.read_text().splitlines()[0])
    with urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json') as response:
        page = next(p for p in json.load(response) if p['type']=='page')
    cdp = Cdp(page['webSocketDebuggerUrl'])
    cdp.call('Page.enable')
    cdp.call('Page.navigate', {'url': f'http://127.0.0.1:{server.server_port}/check.html'})
    def wait(expression, timeout=8):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            if cdp.js(expression): return
            time.sleep(.04)
        raise RuntimeError('Timed out: ' + expression + ' ' + json.dumps(cdp.js('terminalObservations'), ensure_ascii=False)[-4000:])
    def check(name, expression):
        if not cdp.js(expression):
            raise RuntimeError('Check failed: ' + name + ' ' + json.dumps(cdp.js('terminalObservations'), ensure_ascii=False)[-4000:])
        checks.append(name)
    def click(selector): cdp.js(f'document.querySelector({json.dumps(selector)}).click()')
    def type_command(command):
        cdp.js('document.querySelector(".xterm-helper-textarea").focus()')
        cdp.call('Input.insertText', {'text': command})
        cdp.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'text':'\r'})
        cdp.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
    def drag(selector, dx, dy):
        point=cdp.js(f'(()=>{{const r=document.querySelector({json.dumps(selector)}).getBoundingClientRect();return {{x:r.x+20,y:r.y+15}}}})()')
        if selector=='.terminalResizeHandle': point=cdp.js('(()=>{const r=document.querySelector(".terminalResizeHandle").getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()')
        cdp.call('Input.dispatchMouseEvent', {'type':'mousePressed',**point,'button':'left','clickCount':1})
        cdp.call('Input.dispatchMouseEvent', {'type':'mouseMoved','x':point['x']+dx,'y':point['y']+dy,'button':'left','buttons':1})
        cdp.call('Input.dispatchMouseEvent', {'type':'mouseReleased','x':point['x']+dx,'y':point['y']+dy,'button':'left','clickCount':1})
    wait('!!document.querySelector(".floatingTerminalLauncher")')
    check('shell starts only on user open', 'terminalObservations.opens.length===0')
    click('.floatingTerminalLauncher')
    wait('terminalObservations.opens.length===1 && document.querySelector(".floatingTerminalSessionBar").textContent.includes("会话运行中")')
    type_command("stty -echo; printf '__%s__\\n' READY")
    wait('terminalObservations.output.includes("__READY__")')
    check('real xterm is mounted', '!!document.querySelector(".xterm-screen")')
    cdp.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'w','code':'KeyW','windowsVirtualKeyCode':87,'text':'w'})
    cdp.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'w','code':'KeyW','windowsVirtualKeyCode':87})
    cdp.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'u','code':'KeyU','windowsVirtualKeyCode':85,'modifiers':2,'text':'\x15'})
    cdp.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'u','code':'KeyU','windowsVirtualKeyCode':85,'modifiers':2})
    wait('terminalObservations.writes.join("").includes("\\x15")')
    check('terminal keys do not reach waveform shortcuts', 'terminalObservations.shortcutLeaks===0')
    type_command("printf '%s\\n' '中文终端😀'; printf '__%s__\\n' UTF8")
    wait('terminalObservations.output.includes("__UTF8__")')
    check('Unicode travels through real PTY', 'terminalObservations.output.includes("中文终端😀")')
    cdp.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'ArrowUp','code':'ArrowUp','windowsVirtualKeyCode':38})
    cdp.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'ArrowUp','code':'ArrowUp','windowsVirtualKeyCode':38})
    wait('terminalObservations.writes.some(data => data === "\\x1b[A" || data === "\\x1bOA")')
    cdp.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'u','code':'KeyU','windowsVirtualKeyCode':85,'modifiers':2,'text':'\x15'})
    cdp.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'u','code':'KeyU','windowsVirtualKeyCode':85,'modifiers':2})
    check('arrow keys stay inside the terminal', 'terminalObservations.shortcutLeaks===0')
    type_command("printf '__%s__\\n' INTERRUPTING; sleep 20")
    wait('terminalObservations.output.includes("__INTERRUPTING__")')
    cdp.call('Input.dispatchKeyEvent', {'type':'keyDown','key':'c','code':'KeyC','windowsVirtualKeyCode':67,'modifiers':2,'text':'\x03'})
    cdp.call('Input.dispatchKeyEvent', {'type':'keyUp','key':'c','code':'KeyC','windowsVirtualKeyCode':67,'modifiers':2})
    wait('terminalObservations.writes.includes("\\x03")')
    type_command("printf '__%s__\\n' INTERRUPTED")
    wait('terminalObservations.output.includes("__INTERRUPTED__")')
    check('Ctrl+C interrupts the foreground process', 'terminalObservations.output.includes("__INTERRUPTED__")')
    original=cdp.js('(()=>{const r=document.querySelector(".floatingTerminalWindow").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()')
    drag('.floatingTerminalHeader',-100,-90)
    wait(f'document.querySelector(".floatingTerminalWindow").getBoundingClientRect().x < {original["x"]-50}')
    check('floating window drag works',f'document.querySelector(".floatingTerminalWindow").getBoundingClientRect().x < {original["x"]-50}')
    resize_count=cdp.js('terminalObservations.resizes.length')
    drag('.terminalResizeHandle',150,60)
    wait(f'document.querySelector(".floatingTerminalWindow").getBoundingClientRect().width > {original["w"]+100}')
    wait(f'terminalObservations.resizes.length>{resize_count}')
    check('resize changes panel geometry',f'document.querySelector(".floatingTerminalWindow").getBoundingClientRect().width > {original["w"]+100}')
    type_command("stty size; printf '__%s__\\n' SIZE")
    wait('terminalObservations.output.includes("__SIZE__")')
    check('PTY resize matches terminal rows and columns', '(()=>{const s=terminalObservations.resizes.at(-1);return terminalObservations.output.includes(`${s[1]} ${s[0]}`)})()')
    type_command("sleep 0.4; printf '__%s__\\n' BACKGROUND")
    click('button[aria-label="收起为按钮，保留运行中的会话"]')
    wait('terminalObservations.output.includes("__BACKGROUND__")')
    check('collapsed window has no layout footprint', 'document.querySelector(".floatingTerminalWindow").hidden && document.querySelector(".floatingTerminalLauncher").getClientRects().length===1')
    root=workspace/'.verification';root.mkdir(exist_ok=True)
    root.joinpath('terminal-collapsed.png').write_bytes(base64.b64decode(cdp.call('Page.captureScreenshot',{'format':'png'})['data']))
    click('.floatingTerminalLauncher')
    check('reopen keeps one shell and output', 'terminalObservations.opens.length===1 && terminalObservations.output.includes("__BACKGROUND__")')
    cdp.js('document.querySelector(".xterm-helper-textarea").focus()')
    time.sleep(.1)
    root.joinpath('terminal-expanded.png').write_bytes(base64.b64decode(cdp.call('Page.captureScreenshot',{'format':'png'})['data']))
    click('button[aria-label="放大终端"]')
    wait('document.querySelector(".floatingTerminalWindow").getBoundingClientRect().width>=innerWidth-34')
    check('enlarge remains inside application window','(()=>{const r=document.querySelector(".floatingTerminalWindow").getBoundingClientRect();return r.left>=8 && r.right<=innerWidth-8 && r.top>=36 && r.bottom<=innerHeight-40})()')
    click('button[aria-label="恢复终端大小"]')
    type_command('exit 9')
    wait('document.querySelector(".terminalExitBar")?.textContent.includes("9")')
    check('shell exit code is visible', 'document.querySelector(".terminalExitBar").textContent.includes("9")')
    click('.terminalExitBar button')
    wait('terminalObservations.opens.length===2 && document.querySelector(".floatingTerminalSessionBar").textContent.includes("会话运行中")')
    check('restart creates a new session', 'terminalObservations.opens[0]!==terminalObservations.opens[1]')
    click('button[aria-label="关闭终端并结束 shell 会话"]')
    wait('!document.querySelector(".floatingTerminalWindow")')
    check('close ends the shell session', 'terminalObservations.closes.length===2')
    check('geometry preference persisted', '!!localStorage.getItem("sigpilot.terminal.geometry.v1")')
    report={'passed':True,'checks':checks,'shell':cdp.js('terminalObservations.opens.length'),'source':'production Rust PTY + xterm.js'}
    root.joinpath('terminal-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
except Exception:
    if 'cdp' in locals():
        try:
            print('failure geometry',json.dumps(cdp.js('(()=>{const r=document.querySelector(".floatingTerminalWindow")?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null})()')))
            root=workspace/'.verification';root.mkdir(exist_ok=True)
            root.joinpath('terminal-failed.png').write_bytes(base64.b64decode(cdp.call('Page.captureScreenshot',{'format':'png'})['data']))
        except Exception: pass
    raise
finally:
    browser.terminate();browser.wait(timeout=5)
    backend.terminate();backend.wait(timeout=5)
    server.shutdown();server.server_close();profile.cleanup()
