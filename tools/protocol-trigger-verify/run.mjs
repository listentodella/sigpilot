// Exercises the actual React panel/validator; no capture backend is simulated.
import {spawn, execFileSync} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp, readFile, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const build=path.resolve("tools/protocol-trigger-verify/dist");
const dir=await mkdtemp(path.join(tmpdir(),"sigpilot-protocol-trigger-"));
const report={passed:false,scope:"Real ProtocolTriggerPanel and configuration validator; no Tauri or device capture",checks:[],screenshots:[]};
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,"http://localhost");
    const file=path.resolve(build,url.pathname.slice(1)||"index.html");
    if(!file.startsWith(build+path.sep))throw Error("invalid path");
    const data=await readFile(file);
    res.writeHead(200,{"Content-Type":file.endsWith(".html")?"text/html":file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"application/octet-stream","Cache-Control":"no-store"});res.end(data);
  }catch{res.writeHead(404);res.end();}
});
let chrome,ws,seq=0,browserError="";
const pending=new Map();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+15000;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e;}await delay(60);}throw Error(`${label}: ${last?.message??browserError??"timed out"}`);}
function cdp(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function field(label,value){await evaluate(`(()=>{const e=[...document.querySelectorAll('.analyzerTriggerBody label')].find(e=>e.innerText.startsWith(${JSON.stringify(label)}))?.querySelector('input,select');if(!e)throw Error('Missing field: '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);}
async function setSelect(selector,value){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
async function submit(){await click("#submit");return until(()=>evaluate("document.querySelector('#result').textContent && JSON.parse(document.querySelector('#result').textContent)"),"submission");}
function passed(label){report.checks.push(label);}
async function screenshot(locale){const file=`.verification/protocol-trigger-${locale}.png`;const height=await evaluate("Math.ceil(document.querySelector('main').getBoundingClientRect().height)");const shot=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,clip:{x:0,y:0,width:380,height,scale:1}});await writeFile(file,Buffer.from(shot.data,"base64"));report.screenshots.push(file);}
try{
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const binary=process.platform==="darwin"?"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome":"chromium";
  chrome=spawn(binary,["--headless=new","--window-size=900,1000","--disable-gpu","--disable-dev-shm-usage","--disable-background-networking","--disable-extensions","--disable-breakpad","--no-first-run","--remote-debugging-port=0","--user-data-dir="+dir,"about:blank"],{stdio:["ignore","ignore","pipe"]});
  chrome.on("error",error=>browserError=error.message);chrome.stderr.on("data",data=>browserError=(browserError+data).slice(-1200));
  const port=await until(async()=>(await readFile(path.join(dir,"DevToolsActivePort"),"utf8")).split("\n")[0],"Chromium launch");
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(targets.find(target=>target.type==="page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=event=>{const value=JSON.parse(event.data),item=pending.get(value.id);if(!item)return;pending.delete(value.id);value.error?item.reject(Error(value.error.message)):item.resolve(value.result);};
  await cdp("Runtime.enable");await cdp("Page.enable");
  await cdp("Page.navigate",{url:`http://127.0.0.1:${server.address().port}/`});
  await until(()=>evaluate("!!document.querySelector('.analyzerTriggerSwitch input')"),"component render");
  assert.equal(await evaluate("document.querySelector('.analyzerTriggerSwitch input').checked"),false);
  await click(".analyzerTriggerSwitch input");assert(await evaluate("document.querySelector('.analyzerTriggerSwitch').classList.contains('checked')"));await field("Consecutive values","0xAA 55 01");
  const uart=await submit();assert.deepEqual(uart.condition,{type:"uart_sequence",bytes:[170,85,1]});assert.equal(uart.decoder.protocol,"Uart");assert.equal(uart.decoder.settings.baud_rate,115200);passed("UART hex sequence submits exact configured decoder");
  await field("Before T0",30);await field("After T0",40);await field("Maximum wait",2500);
  const windows=await submit();assert.deepEqual([windows.pre_trigger_ms,windows.post_trigger_ms,windows.max_wait_ms],[30,40,2500]);passed("pre/post/wait controls produce requested values");
  await field("Consecutive values","GG");assert.equal((await submit()).error,"hex");assert(await evaluate("!!document.querySelector('[role=alert]')"));passed("malformed hex shows actionable validation and rejects submission");
  await field("Consecutive values","AA");await setSelect("#mode","Buffer");assert.equal((await submit()).error,"stream");await setSelect("#mode","Stream");passed("buffer mode cannot silently act as realtime trigger");
  await field("Analyzer","i2c");await until(()=>evaluate("document.body.innerText.includes('7-bit address')"),"I2C fields");
  await field("7-bit address","50");await field("Data byte (hex","ff");
  const nack=await submit();assert.deepEqual(nack.condition,{type:"i2c",address:80,event:"nack",data:255});passed("I2C address plus data NACK filtering");
  await field("Event","address");const address=await submit();assert.equal(address.condition.data,null);assert.equal(address.condition.event,"address");passed("I2C address event clears hidden data restriction");
  await field("7-bit address","80");assert.equal((await submit()).error,"value");await field("7-bit address","50");passed("7-bit I2C address range validation");
  await field("Analyzer","spi");await until(()=>evaluate("document.body.innerText.includes('Data line')"),"SPI fields");
  await field("Data line","miso");await field("Consecutive values","03 10");
  const spi=await submit();assert.deepEqual(spi.condition,{type:"spi_sequence",line:"miso",values:[3,16]});assert.equal(spi.decoder.settings.miso_channel,2);passed("SPI MISO sequence retains channel and word settings");
  for(const id of ["busy","readonly"]){await click("#"+id);assert(await evaluate("[...document.querySelectorAll('.analyzerTriggerView input,.analyzerTriggerView select')].every(e=>e.disabled)"));await click("#"+id);passed(`${id} locks configuration controls`);}
  await click("#desktop");assert(await evaluate("document.querySelector('.analyzerTriggerSwitch input').disabled"));assert.equal((await submit()).error,"desktopOnly");await click("#desktop");passed("browser/WebUSB explicitly unavailable, no fabricated trigger");
  await mkdir(".verification",{recursive:true});
  await submit();await screenshot("en");await click("#chinese");await until(()=>evaluate("document.body.innerText.includes('协议内容触发')"),"Chinese locale");
  assert.equal(await evaluate("document.querySelector('.analyzerTriggerView').scrollWidth <= document.querySelector('.analyzerTriggerView').clientWidth"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('.analyzerTriggerView input,.analyzerTriggerView select')].every(e=>e.getBoundingClientRect().right<=document.querySelector('.analyzerTriggerView').getBoundingClientRect().right)"),true);
  await screenshot("zh-CN");passed("Chinese labels and compact panel layout without horizontal overflow");
  await click(".analyzerTriggerExpandButton");assert.equal(await evaluate("document.querySelector('.analyzerTriggerBody')"),null);await click(".analyzerTriggerExpandButton");assert.equal((await submit()).condition.line,"miso");passed("collapse removes inactive controls and preserves configuration");
  report.browser=execFileSync(binary,["--version"],{encoding:"utf8"}).trim();report.passed=true;
}catch(error){report.error=String(error);throw error;}
finally{
  await mkdir(".verification",{recursive:true});await writeFile(".verification/protocol-trigger-ui.json",JSON.stringify(report,null,2));
  ws?.close();chrome?.kill("SIGKILL");server.closeAllConnections();server.close();
  await rm(dir,{force:true,recursive:true,maxRetries:4,retryDelay:100});
  console.log(JSON.stringify(report,null,2));
}
