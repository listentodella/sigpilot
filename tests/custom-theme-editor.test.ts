import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as themeData from "../src/lib/customThemes.ts";
import * as themes from "../src/lib/themes.ts";

// Headless component-state tests. Execute the real TSX handlers with a minimal
// hook runner; these exercise state transitions, not browser layout or focus.
function editorHarness(saveError = false, existingLibrary = themeData.emptyThemeLibrary()) {
  const slots: any[] = [];
  let cursor = 0, dirty = true;
  const effects: Array<{ index: number; run: () => void | (() => void) }> = [];
  const cleanups = new Map<number, () => void>();
  const previews: any[] = [], saves: any[] = [];
  let tree: any;
  const jsx = (type: any, props: any, key?: any) => ({ type, props: props ?? {}, key });
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); },
    useEffect(run: () => void | (() => void), deps: any[]) {
      const index = cursor++;
      const before = slots[index];
      if (!before || deps.some((value, offset) => !Object.is(value, before[offset]))) {
        slots[index] = deps; effects.push({ index, run });
      }
    },
  };
  const source = readFileSync(new URL("../src/components/CustomThemeEditor.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: any = {};
  vm.runInNewContext(compiled, {
    exports, window: { confirm: () => true }, console, setTimeout,
    require(name: string) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
      if (name === "../lib/customThemes") return themeData;
      if (name === "../lib/themes") return themes;
      throw new Error(`Unexpected component import ${name}`);
    },
  });
  const props = {
    themeId: existingLibrary.themes[0]?.id ?? "saleae-dark", library: existingLibrary,
    channelContext: { profileId: "test:D16:A2", label: "Test device", channels: [
      { id: "D0", label: "D0", enabled: true }, { id: "D8", label: "Clock", enabled: false },
      { id: "A0", label: "A0", enabled: true },
    ] },
    onSave: (library: any, id: string) => { if (saveError) throw new Error("quota"); saves.push({ library, id }); },
    onPreview: (preview: any) => previews.push(preview), onEditingChange: () => {},
  };
  function render() {
    let iterations = 0;
    do {
      assert.ok(iterations++ < 20, "component must settle");
      dirty = false; cursor = 0;
      tree = exports.CustomThemeEditor(props);
      for (const effect of effects.splice(0)) {
        cleanups.get(effect.index)?.();
        const cleanup = effect.run();
        if (cleanup) cleanups.set(effect.index, cleanup); else cleanups.delete(effect.index);
      }
    } while (dirty);
    return tree;
  }
  function nodes(root: any): any[] {
    if (!root || typeof root !== "object") return [];
    if (Array.isArray(root)) return root.flatMap((child) => nodes(child));
    return [root, ...(root.props?.children === undefined ? [] : nodes(root.props.children))];
  }
  function find(predicate: (node: any) => boolean) {
    const node = nodes(tree).find(predicate);
    assert.ok(node, "expected editor control"); return node;
  }
  function click(text: string) {
    const button = find((node) => node.type === "button" && node.props.children === text);
    assert.ok(!button.props.disabled); button.props.onClick(); render();
  }
  render();
  return { render, find, click, previews, saves, nodes,
    unmount: () => { for (const cleanup of cleanups.values()) cleanup(); },
  };
}

test("editor previews a copied draft, edits semantic colors, and cancels without saving", () => {
  const harness = editorHarness();
  harness.click("editor.copy");
  assert.ok(harness.previews.at(-1));
  const field = harness.find((node) => node.props.label === "editor.colors.panel");
  field.props.onChange("#123456"); harness.render();
  assert.equal(harness.previews.at(-1).theme.cssVars["--background-20"], "#123456");
  harness.click("editor.cancel");
  assert.equal(harness.previews.at(-1), null);
  assert.equal(harness.saves.length, 0);
});

test("editor saves physical channel overrides and can restore inheritance independently", () => {
  const harness = editorHarness();
  harness.click("editor.copy");
  harness.find((node) => node.props.label === "D8 Clock").props.onChange("#112233");
  harness.render();
  assert.equal(harness.previews.at(-1).channelOverrides["test:D16:A2"].D8, "#112233");
  harness.find((node) => node.props.label === "A0 ").props.onChange("#aabbcc");
  harness.render();
  const row = harness.find((node) => node.props.className === "themeChannelRow" && node.props.children[0]?.props.label === "D8 Clock");
  row.props.children[2].props.onClick(); harness.render();
  harness.click("editor.apply");
  const saved = harness.saves[0];
  assert.equal(saved.library.channelOverrides["test:D16:A2"].D8, undefined);
  assert.equal(saved.library.channelOverrides["test:D16:A2"].A0, "#aabbcc");
  assert.equal(saved.library.themes[0].id, saved.id);
  assert.equal(harness.previews.at(-1), null);
});

test("preview toggle and unmount restore saved theme; storage error retains editable draft", () => {
  const harness = editorHarness(true);
  harness.click("editor.copy");
  harness.find((node) => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: false } });
  harness.render();
  assert.equal(harness.previews.at(-1), null);
  harness.click("editor.apply");
  assert.ok(harness.find((node) => node.props.role === "alert").props.children.includes("quota"));
  assert.ok(harness.find((node) => node.type === "input" && node.props["aria-label"] === "editor.name"));
  harness.unmount();
  assert.equal(harness.previews.at(-1), null);
});

test("JSON import creates a reversible new draft and reports malformed input", async () => {
  const theme = themeData.createCustomTheme(themes.getUiTheme("lab-light"), "custom-import-ui-test");
  const payload = themeData.exportCustomTheme(theme, { "test:D16:A2": { D8: "#112233" } });
  const harness = editorHarness();
  const upload = harness.find((node) => node.type === "input" && node.props.type === "file");
  upload.props.onChange({ target: { files: [{ size: payload.length, text: async () => payload }], value: "file" } });
  await new Promise((resolve) => setImmediate(resolve));
  harness.render();
  assert.notEqual(harness.previews.at(-1).theme.id, theme.id);
  assert.equal(harness.previews.at(-1).channelOverrides["test:D16:A2"].D8, "#112233");
  assert.equal(harness.saves.length, 0);
  harness.click("editor.cancel");
  assert.equal(harness.previews.at(-1), null);
  upload.props.onChange({ target: { files: [{ size: 7, text: async () => "invalid" }], value: "file" } });
  await new Promise((resolve) => setImmediate(resolve));
  harness.render();
  assert.ok(harness.find((node) => node.props.role === "alert"));
  assert.equal(harness.saves.length, 0);
});

test("deleting a custom theme selects its base without dropping device colors", () => {
  const theme = themeData.createCustomTheme(themes.getUiTheme("lab-light"), "custom-delete-ui-test");
  const library = { ...themeData.emptyThemeLibrary(), themes: [theme], channelOverrides: { "test:D16:A2": { D8: "#123456" } } };
  const harness = editorHarness(false, library);
  harness.click("editor.delete");
  assert.equal(harness.saves[0].id, "lab-light");
  assert.equal(harness.saves[0].library.themes.length, 0);
  assert.equal(harness.saves[0].library.channelOverrides["test:D16:A2"].D8, "#123456");
});
