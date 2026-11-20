import assert from "node:assert/strict";
import test from "node:test";
import { createAnalyzerInstance } from "../src/lib/analyzers.ts";
import type { CaptureSettings } from "../src/lib/api.ts";
import { buildProtocolTrigger, defaultProtocolTrigger, parseTriggerHex, protocolTriggerDecoder, ProtocolTriggerValidationError } from "../src/lib/protocolTrigger.ts";

const settings: CaptureSettings = {
  device_id: "demo", sample_rate_hz: 1_000_000, channel_count: 8, enabled_channels: [0,1,2,3,4,5,6,7],
  duration_ms: 100, buffer_size_mb: 64, decode_cross: true, threshold_volts: 2,
  external_trigger_mode: "Close", mode: "Stream", trigger_enabled: false, trigger_channel: 0,
  trigger_kind: "Rising", trigger_high_mask: 0, trigger_low_mask: 0, trigger_position_percent: 50,
  glitch_filter_enabled: false, clock_edge: false, trigger_out_enabled: false,
};
function analyzer(type: string) {
  const item = createAnalyzerInstance(type, [], 0, "saleae_native");
  item.configurationValid = true;
  return item;
}
function state(id: string) { return { ...defaultProtocolTrigger(), enabled: true, analyzerId: id, query: "AA 55 01" }; }
function error(code: string) { return (value: unknown) => value instanceof ProtocolTriggerValidationError && value.code === code; }

test("hex values are explicit, bounded and never silently truncated", () => {
  assert.deepEqual(parseTriggerHex("0xaa, 55\n01", 8), [170,85,1]);
  assert.deepEqual(parseTriggerHex("FFFFFFFF", 32), [0xffffffff]);
  for (const input of ["10zz", "-1", "0x", "1.5"]) assert.throws(() => parseTriggerHex(input,8), error("hex"));
  assert.throws(() => parseTriggerHex("100",8), error("value"));
  assert.throws(() => parseTriggerHex("",8), error("length"));
  assert.throws(() => parseTriggerHex(Array(65).fill("AA").join(" "),8), error("length"));
});

test("Saleae UART uses the configured wire format exactly", () => {
  const item = analyzer("Async Serial");
  Object.assign(item, {channel:3, baudRate:9600, uartDataBits:7, uartStopBits:2, uartParity:"odd", uartMsbFirst:true, inverted:true});
  const config = buildProtocolTrigger({...state(item.id), query:"55 01"}, [item], settings, true)!;
  assert.equal(config.decoder.protocol, "Uart");
  assert.deepEqual(config.decoder.settings, {channel:3,baud_rate:9600,data_bits:7,stop_bits:2,parity:"odd",msb_first:true,inverted:true});
  assert.deepEqual(config.condition, {type:"uart_sequence",bytes:[85,1]});
  assert.throws(() => buildProtocolTrigger(state(item.id),[item],settings,true),error("value"));
  item.uartDataBits=9;
  assert.throws(() => buildProtocolTrigger(state(item.id),[item],settings,true),error("uartFormat"));
});

test("I2C supports address/data/NACK predicates without carrying hidden data filters", () => {
  const item=analyzer("I2C"); item.i2cSdaChannel=1;item.i2cSclChannel=2;
  const config=buildProtocolTrigger({...state(item.id),i2cAddress:"50",i2cData:"ff"},[item],settings,true)!;
  assert.deepEqual(config.condition,{type:"i2c",address:0x50,event:"nack",data:255});
  const address=buildProtocolTrigger({...state(item.id),i2cEvent:"address",i2cData:"ff"},[item],settings,true)!;
  assert.deepEqual(address.condition,{type:"i2c",address:null,event:"address",data:null});
  assert.throws(() => buildProtocolTrigger({...state(item.id),i2cAddress:"80"},[item],settings,true),error("value"));
});

test("SPI uses configured lines and word size and refuses missing selected line", () => {
  const item=analyzer("SPI");Object.assign(item,{spiClockChannel:0,spiMosiChannel:1,spiMisoChannel:2,spiEnableChannel:3,spiBitsPerTransfer:16,spiClockPhase:true});
  const config=buildProtocolTrigger({...state(item.id),spiLine:"miso",query:"AABB 1000"},[item],settings,true)!;
  assert.deepEqual(config.condition,{type:"spi_sequence",values:[0xaabb,0x1000],line:"miso"});
  assert.equal(config.decoder.protocol,"Spi");if(config.decoder.protocol==="Spi")assert.equal(config.decoder.settings.clock_phase,true);
  item.spiMisoChannel=null;
  assert.throws(() => buildProtocolTrigger({...state(item.id),spiLine:"miso"},[item],settings,true),error("spiLine"));
});

test("unsupported runtimes, capture modes, channel roles and deadlines fail before capture", () => {
  const item=analyzer("Async Serial");const current=state(item.id);
  assert.equal(buildProtocolTrigger({...current,enabled:false},[],settings,false),undefined);
  assert.throws(()=>buildProtocolTrigger(current,[item],settings,false),error("desktopOnly"));
  assert.throws(()=>buildProtocolTrigger(current,[item],{...settings,mode:"Buffer"},true),error("stream"));
  assert.throws(()=>buildProtocolTrigger(current,[item],{...settings,device_id:"pxlogic",decode_cross:false},true),error("rawFormat"));
  for (const device_id of ["fake:sigpilot-demo", "usb-kingst:fixture"])
    assert(buildProtocolTrigger(current,[item],{...settings,device_id,decode_cross:false},true));
  for(const patch of [{trigger_enabled:true},{external_trigger_mode:"Rising" as const},{trigger_out_enabled:true}])
    assert.throws(()=>buildProtocolTrigger(current,[item],{...settings,...patch},true),error("hardware"));
  assert.throws(()=>buildProtocolTrigger(current,[item],{...settings,enabled_channels:[7]},true),error("channels"));
  assert.throws(()=>buildProtocolTrigger(current,[item],{...settings,sample_rate_hz:100000},true),error("uartRate"));
  for(const patch of [{maxWaitMs:0},{postTriggerMs:60001},{preTriggerMs:0.1},{maxWaitMs:Infinity}])
    assert.throws(()=>buildProtocolTrigger({...current,...patch},[item],settings,true),error("duration"));
  item.configurationValid=false;assert.equal(protocolTriggerDecoder(item),null);
  assert.throws(()=>buildProtocolTrigger(current,[item],settings,true),error("select"));
  const native=analyzer("I2S");assert.equal(protocolTriggerDecoder(native),null);
  const i2c=analyzer("I2C");i2c.i2cSdaChannel=i2c.i2cSclChannel=1;
  assert.throws(()=>buildProtocolTrigger(state(i2c.id),[i2c],settings,true),error("channels"));
});
