import assert from "node:assert/strict";
import test from "node:test";
import { mcpCaptureAnalyzers } from "../src/lib/mcpCapture.ts";
import { analyzerDecodeSettings } from "../src/lib/analyzers.ts";
import type { AnalyzerDecodeSettings } from "../src/lib/api.ts";

test("MCP capture tabs preserve typed protocol settings and stable session-scoped IDs", () => {
  const settings: AnalyzerDecodeSettings[] = [
    { protocol:"Uart", settings:{channel:3,baud_rate:9600,data_bits:7,stop_bits:1.5,parity:"odd",msb_first:true,inverted:true} },
    { protocol:"I2c", settings:{sda_channel:1,scl_channel:2} },
    { protocol:"Spi", settings:{mosi_channel:null,miso_channel:7,clock_channel:5,enable_channel:6,enable_active_low:false,clock_polarity:true,clock_phase:true,bits_per_transfer:32,msb_first:false} },
  ];
  const analyzers=mcpCaptureAnalyzers("mcp-capture-a",settings);
  assert.deepEqual(analyzers.map((analyzer)=>analyzerDecodeSettings(analyzer)),settings);
  assert.deepEqual(analyzers.map((analyzer)=>analyzer.id),["mcp-capture-a-analyzer-0","mcp-capture-a-analyzer-1","mcp-capture-a-analyzer-2"]);
  assert(analyzers.every((analyzer)=>analyzer.configurationValid && analyzer.decoderBackend==="saleae_native"));
  const other=mcpCaptureAnalyzers("mcp-capture-b",settings);
  assert(other.every((analyzer,index)=>analyzer.id!==analyzers[index].id));
});

test("unknown acquisition analyzer kinds do not silently create a default UART analyzer", () => {
  const settings: AnalyzerDecodeSettings[]=[{protocol:"Native",settings:{decoder_id:"custom",protocol_name:"Custom",channels:{},options:{},primary_channel:0}}];
  assert.deepEqual(mcpCaptureAnalyzers("mcp-capture",settings),[]);
});
