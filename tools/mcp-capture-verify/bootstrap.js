// Explicit debug-only verification script for the real SigPilot WKWebView.
// The app injects this only when SIGPILOT_VERIFY_SCRIPT names a local file.
// It never exposes terminal execution through MCP or an HTTP debug endpoint.
(async () => {
  if (globalThis.__sigpilotCaptureVerificationRunning) return;
  globalThis.__sigpilotCaptureVerificationRunning = true;
  const config = globalThis.__SIGPILOT_CAPTURE_VERIFY__;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const report = { passed: false, scope: "Actual desktop window and built-in PTY running Codex CLI", phases: [] };
  let originalInvoke, internals, terminalId, callbacks, previousSetDescriptor, outputTail = "", expectedAuthorization = null;
  let driverResult = null, failure = null, originalSettings = null;
  const observations = { terminalSessions: 0, terminalPolls: 0 };
  const pendingBefore = new Set();
  const decoder = new TextDecoder();
  const writeReport = async () => {
    if (!originalInvoke) return;
    await originalInvoke("write_text_file", { request: {
      path: config.output + "/desktop-report.txt", contents: JSON.stringify(report, null, 2),
    }});
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return !element.hidden && style.visibility !== "hidden" && style.display !== "none"
      && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth;
  };
  const screenshot = async (name) => {
    await focusWindow();
    const framesAdvanced = await settle();
    const image = await originalInvoke("capture_screenshot_png");
    const path = config.output + "/" + name;
    await originalInvoke("write_screenshot_file", { request: { path, dataBase64: image } });
    (report.screenshotEvidence ??= []).push({ path, framesAdvanced,
      status: framesAdvanced ? "frame_clock_advanced" : "snapshot_may_be_stale" });
    return path;
  };
  const settle = async () => {
    const advanced = await new Promise((resolve) => {
      let first, second, done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (first !== undefined) cancelAnimationFrame(first);
        if (second !== undefined) cancelAnimationFrame(second);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 1500);
      first = requestAnimationFrame(() => { second = requestAnimationFrame(() => finish(true)); });
    });
    await sleep(500);
    (report.frameClockChecks ??= []).push({ advanced, visibility: document.visibilityState,
      focused: document.hasFocus(), timestamp: new Date().toISOString() });
    return advanced;
  };
  const focusWindow = async () => {
    try {
      await originalInvoke("plugin:window|set_focus", { label: "main" });
      report.windowFocus = "focused";
    } catch (error) {
      // core:default may not grant set_focus. The debug Rust launcher can focus
      // once; never add a production capability merely for this test script.
      report.windowFocus = "not_granted";
      report.windowFocusError = String(error).slice(0,300);
    }
  };
  async function until(predicate, label, ms = 30000) {
    const limit = Date.now() + ms;
    while (Date.now() < limit) {
      const result = await predicate();
      if (result) return result;
      await sleep(100);
    }
    throw new Error(label + " timed out");
  }
  function processOutput(data) {
    outputTail += decoder.decode(Uint8Array.from(data), { stream: true }).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const lines = outputTail.split(/\r?\n/);
    outputTail = lines.pop().slice(-16384);
    for (const line of lines) {
      const index = line.indexOf("SIGPILOT_VERIFY_EVENT ");
      if (index < 0) continue;
      try {
        const event = JSON.parse(line.slice(index + 22));
        if (event.kind === "oauth_pending") expectedAuthorization = event;
        if (event.kind === "done") driverResult = event;
        if (event.kind === "failure") failure = event.message;
        if (event.kind === "phase") report.phases.push(event.name);
      } catch { /* A split PTY line is retained until its newline. */ }
    }
  }
  try {
    if (!config || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(config.endpoint)) throw Error("Invalid explicit verification configuration");
    await until(() => document.querySelector(".logic-root") && window.__TAURI_INTERNALS__?.invoke, "desktop UI");
    if (document.querySelector(".floatingTerminalWindow")) throw Error("A terminal already exists; refusing to use another session");
    internals = window.__TAURI_INTERNALS__;
    originalInvoke = internals.invoke.bind(internals);
    // Tauri defines invoke as non-writable. Observe only the terminal response
    // shapes through its mutable callback map, preserving every real callback.
    callbacks = internals.callbacks;
    if (!(callbacks instanceof Map) || !Object.isExtensible(callbacks)) throw Error("Tauri callback observation is unavailable");
    previousSetDescriptor = Object.getOwnPropertyDescriptor(callbacks, "set");
    const originalSet = callbacks.set;
    const observeSet = function (key, callback) {
      return originalSet.call(this, key, (value) => {
        if (value && typeof value === "object") {
          if (Object.keys(value).length === 3 && typeof value.id === "string"
            && typeof value.shell === "string" && typeof value.cwd === "string") {
            observations.terminalSessions += 1;
            if (!terminalId) terminalId = value.id;
          } else if (terminalId && Object.keys(value).length === 4 && Array.isArray(value.data)
            && typeof value.exited === "boolean" && "exit_code" in value && "error" in value) {
            observations.terminalPolls += 1;
            processOutput(value.data);
          }
        }
        return callback(value);
      });
    };
    callbacks.set = observeSet;
    if (callbacks.set !== observeSet) throw Error("Tauri callback observation could not be installed");
    const invokeDescriptor = Object.getOwnPropertyDescriptor(internals, "invoke");
    report.diagnostics = { invokeWritable: Boolean(invokeDescriptor?.writable),
      callbackObserverInstalled: true, observations };
    await focusWindow();
    await settle();
    originalSettings = await originalInvoke("mcp_setup_info");
    report.previousService = { enabled: originalSettings.status.enabled,
      can_edit_annotations: originalSettings.status.can_edit_annotations,
      can_capture: originalSettings.status.can_capture, port: originalSettings.port };
    const auth = await originalInvoke("mcp_authorization_status");
    for (const request of auth.pending) pendingBefore.add(request.request_id);
    const status = await originalInvoke("configure_mcp", {
      enabled: true, canEditAnnotations: true, canCapture: true,
      port: Number(new URL(config.endpoint).port),
    });
    if (!status.enabled || status.can_capture !== true) throw Error("Desktop did not grant MCP acquisition permission");
    report.phases.push("Desktop MCP enabled with explicit acquisition permission");
    await writeReport();
    const launcher = await until(() => document.querySelector(".floatingTerminalLauncher"), "terminal launcher");
    launcher.click();
    await until(() => terminalId && document.querySelector(".terminalStateDot.running"), "built-in PTY");
    report.terminal = { id: terminalId, visible: !document.querySelector(".floatingTerminalWindow").hidden };
    report.phases.push("Real floating terminal opened");
    await writeReport();
    await originalInvoke("terminal_write", { id: terminalId, data: config.command + "\r" });
    const deadline = Date.now() + 12 * 60 * 1000;
    let lastReport = Date.now();
    while (!driverResult && !failure && Date.now() < deadline) {
      if (expectedAuthorization) {
        const expected = expectedAuthorization;
        const current = await originalInvoke("mcp_authorization_status");
        const own = current.pending.find((item) => item.request_id === expected.request_id
          && item.redirect_uri === expected.redirect_uri && /codex/i.test(item.client_name)
          && !pendingBefore.has(item.request_id));
        if (own) {
          const callback = new URL(own.redirect_uri);
          if (callback.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname)) {
            throw Error("Refusing non-local Codex callback");
          }
          await originalInvoke("mcp_decide_authorization", { requestId: own.request_id, allow: true });
          report.phases.push("Approved only this verification's Codex authorization request");
          expectedAuthorization = null;
        }
      }
      if (Date.now() - lastReport >= 2000) {
        await writeReport();
        lastReport = Date.now();
      }
      await sleep(200);
    }
    if (failure) throw Error(failure);
    if (!driverResult) throw Error("Codex driver did not finish within 12 minutes");
    report.driver = driverResult;
    report.cliPassed = driverResult.passed === true;
    report.guiStatus = "pending";
    await writeReport();
    report.screenshot = await screenshot("desktop-terminal.png");
    // This selector identifies the existing collapse control by its Minus icon;
    // never click the neighboring maximize or close controls as a fallback.
    const minimize = document.querySelector(".floatingTerminalHeader button svg.lucide-minus")?.closest("button");
    if (!minimize) throw Error("Floating terminal minimize control was not found");
    minimize.click();
    await until(() => document.querySelector(".floatingTerminalWindow")?.hidden
      && document.querySelector(".floatingTerminalLauncher"), "terminal minimization");
    const framesAdvanced = await settle();
    const rows = [...document.querySelectorAll(".channelRow[data-channel-index]")].filter(visible);
    const markers = [...document.querySelectorAll("[data-finalized-timing-marker] .timingMarkerHead")].filter(visible);
    report.gui = {
      visibleChannelCount: rows.length,
      visibleChannels: rows.map((row) => ({ channel: Number(row.getAttribute("data-channel-index")), text: row.innerText })),
      visibleMarkerCount: markers.length,
      markerText: markers.map((marker) => ({ text: marker.innerText, label: marker.getAttribute("aria-label") })),
      terminalMinimized: Boolean(document.querySelector(".floatingTerminalWindow")?.hidden),
    };
    report.waveformScreenshot = await screenshot("desktop-waveform.png");
    if (config.allowHardware && driverResult.passed === true) {
      const screenshotAdvanced = report.screenshotEvidence.at(-1)?.framesAdvanced === true;
      report.guiPassed = framesAdvanced && screenshotAdvanced
        ? [0, 1, 2, 3].every((channel) => rows.some((row) => Number(row.getAttribute("data-channel-index")) === channel)) && markers.length > 0
        : null;
      report.guiStatus = report.guiPassed === null ? "unavailable_background_frame_clock"
        : report.guiPassed ? "passed" : "failed";
      report.passed = report.cliPassed && report.guiPassed === true;
    } else {
      report.guiStatus = config.allowHardware ? "not_checked_cli_failed" : "not_required_demo_released";
      report.passed = report.cliPassed;
    }
    // Leave the installed connection and minimized terminal for review.
    // Tests never disable an existing service or remove unrelated clients.
  } catch (error) {
    report.passed = false;
    report.error = String(error);
    report.diagnostics = { ...report.diagnostics, terminalId: terminalId ?? null,
      terminalWindowExists: Boolean(document.querySelector(".floatingTerminalWindow")),
      terminalRunning: Boolean(document.querySelector(".terminalStateDot.running")),
      terminalText: document.querySelector(".floatingTerminalWindow")?.innerText?.slice(-3000) ?? null };
    if (originalInvoke) await originalInvoke("frontend_log", { level: "error", module: "main", message: "MCP desktop verification: " + String(error) }).catch(() => {});
  } finally {
    if (originalInvoke && !report.screenshot) {
      try {
        const image = await originalInvoke("capture_screenshot_png");
        await originalInvoke("write_screenshot_file", { request: {
          path: config.output + "/desktop-terminal.png", dataBase64: image,
        }});
        report.screenshot = config.output + "/desktop-terminal.png";
      } catch { /* Preserve the original failure if window capture also fails. */ }
    }
    await writeReport().catch(() => {});
    if (callbacks) {
      if (previousSetDescriptor) Object.defineProperty(callbacks, "set", previousSetDescriptor);
      else delete callbacks.set;
    }
    globalThis.__sigpilotCaptureVerificationResult = report;
  }
})();
