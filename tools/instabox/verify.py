#!/usr/bin/env python3
"""Sequential MCP verification inside Instabox; invoke through limited-run.py."""
import platform
from pathlib import Path

workspace=Path.cwd().resolve()
if platform.system()!="Linux" or "instabox" not in platform.release() or not str(workspace).startswith("/data/workspace/sigpilot-mcp-"):
    raise SystemExit("verification is restricted to the isolated Instabox workspace")
import subprocess
import sys

commands = {
    'rust': [
        ['/usr/local/bin/cargo','fmt','-p','sigpilot-analysis','-p','sigpilot-workbench','-p','sigpilot-mcp','-p','sigpilot-file'],
        ['/usr/local/bin/cargo','test','-p','sigpilot-analysis','-p','sigpilot-workbench','-p','sigpilot-mcp','-p','sigpilot-file','-p','sigpilot-graph','--locked'],
        ['/usr/local/bin/cargo','build','-p','sigpilot-mcp','--example','analyzer_gui_fixture','--locked'],
    ],
    'frontend': [
        ['/usr/local/bin/cargo','build','-p','sigpilot-mcp','--bins','--locked'],
        ['/usr/local/bin/node','node_modules/typescript/bin/tsc','--noEmit'],
        ['/usr/local/bin/node','--experimental-strip-types','--test','tests/workbench.test.ts','tests/workbench-analyzers.test.ts'],
        ['/usr/bin/python3','tools/mcp-analyzers-verify/run.py'],
        ['/usr/bin/python3','tools/mcp-markers-verify/run.py'],
        ['/usr/bin/python3','tools/instabox/mcp-smoke.py','target/debug/sigpilot-mcp'],
    ],
}
commands['onboarding']=[
    ['/usr/local/bin/cargo','fmt','-p','sigpilot-mcp','-p','sigpilot-desktop'],
    ['/usr/local/bin/cargo','test','-p','sigpilot-mcp','--locked'],
    ['/usr/local/bin/cargo','build','-p','sigpilot-mcp','--example','onboarding_gui_fixture','--locked'],
    ['/usr/local/bin/node','scripts/prepare-mcp-bridge.mjs','--profile','dev'],
    ['/usr/local/bin/node','node_modules/typescript/bin/tsc','--noEmit'],
    ['/usr/bin/python3','tools/mcp-onboarding-verify/run.py'],
]
commands['onboarding-rust']=commands['onboarding'][:3]
commands['onboarding-ui']=commands['onboarding'][3:]
commands['onboarding-fixture']=[['/usr/local/bin/cargo','fmt','-p','sigpilot-mcp'],commands['onboarding'][2]]
commands['onboarding-browser']=commands['onboarding'][4:]
commands['http-rust']=[
    ['/usr/local/bin/cargo','test','-p','sigpilot-mcp','--lib','--test','http_onboarding','--test','onboarding','--test','desktop_bridge','--test','request_cancellation','--locked','--offline'],
    commands['onboarding'][2],
]
commands['http-ui']=commands['onboarding'][4:]
commands['http-windows']=[['/usr/local/bin/cargo','check','-p','sigpilot-mcp','--lib','--target','x86_64-pc-windows-gnu','--locked','--offline']]
commands['desktop']=[['/usr/local/bin/cargo','fmt','-p','sigpilot-desktop'],['/usr/local/bin/cargo','check','-p','sigpilot-desktop','--bin','sigpilot-desktop','--locked']]
if len(sys.argv)!=2 or sys.argv[1] not in ('all',*commands):
    raise SystemExit("usage: verify.py rust|frontend|all|desktop|onboarding|onboarding-rust|onboarding-ui|onboarding-fixture|onboarding-browser|http-rust|http-ui|http-windows")
selected = commands['rust'] + commands['frontend'] if sys.argv[1] == 'all' else commands[sys.argv[1]]
for command in selected:
    print('VERIFY',command,flush=True)
    subprocess.run(command,check=True)
