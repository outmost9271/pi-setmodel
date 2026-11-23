import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import createExtension, {
  argumentCompletions, createSetmodelAutocompleteProvider, findExactModelMatch,
} from "./extensions/setmodel.ts";

const models = [
  { provider: "lab", id: "reasoner", name: "Reasoner", reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
  { provider: "lab", id: "plain", name: "Plain", reasoning: false },
  { provider: "other", id: "plain", name: "Other Plain", reasoning: false },
  { provider: "router", id: "org/target@v1", name: "Target", reasoning: false },
];
const source = { scopedModels: [], modelRegistry: { getAvailable: () => models } };
const suggest = (raw) => argumentCompletions(source, raw);
const reasoner = { value: "lab/reasoner ", label: "reasoner", description: "lab" };
const levels = (...labels) => labels.map((label) => ({ value: `lab/reasoner ${label}`, label }));

for (const [name, raw, expected] of [
  ["empty", "", [reasoner, { value: "lab/plain ", label: "plain", description: "lab" },
    { value: "other/plain ", label: "plain", description: "other" },
    { value: "router/org/target@v1 ", label: "org/target@v1", description: "router" }]],
  ["extra leading spaces and fuzzy match", " \t rsnr", [reasoner]],
  ["exact model can be submitted without level", "LAB/REASONER", null],
  ["levels filtered by model metadata", "  lab/reasoner   ", levels("off", "high", "max")],
  ["case-insensitive level prefix", "lab/reasoner \t M", levels("max")],
  ["complete level", "lab/reasoner MAX", null],
  ["complete level and trailing spaces", "lab/reasoner off  ", null],
  ["unsupported level", "lab/reasoner x", null],
  ["extra argument", "lab/reasoner hi x", null],
  ["unknown model", "unknown ", null],
  ["ambiguous model", "plain ", null],
  ["non-reasoning model", "lab/plain ", [{ value: "lab/plain off", label: "off" }]],
  ["embedded slash and at", "router/org/target@v1 ", [{ value: "router/org/target@v1 off", label: "off" }]],
  ["no quote grammar", '"lab/reasoner" ', null],
  ["no unterminated quotes", "'lab/reasoner ", null],
]) {
  test(`candidate: ${name}`, () => assert.deepEqual(suggest(raw), expected));
}

test("scope, bare ID uniqueness and canonical references", () => {
  const scoped = { ...source, scopedModels: [{ model: models[2] }] };
  assert.deepEqual(argumentCompletions(scoped, "")?.map(({ value }) => value), ["other/plain "]);
  assert.deepEqual(argumentCompletions(scoped, "plain "), [{ value: "plain off", label: "off" }]);
  assert.equal(findExactModelMatch("plain", models), undefined);
  assert.equal(findExactModelMatch("reasoner", models), models[0]);
  assert.equal(findExactModelMatch("ROUTER/ORG/TARGET@V1", models), models[3]);
});

const signal = new AbortController().signal;
const native = new CombinedAutocompleteProvider(["setmodel:2", "else"]);

test("provider uses raw argument replacement for normal and forced queries", async () => {
  const accepted = [];
  const wrapped = createSetmodelAutocompleteProvider(native, "setmodel:2", suggest, (...args) => accepted.push(args));
  const start = "/setmodel:2   rsnr";
  const opts = { signal, force: true };
  const menu = await wrapped.getSuggestions([start], 0, start.length, opts);
  assert.deepEqual(menu, { prefix: "  rsnr", items: [reasoner] });
  assert.deepEqual(wrapped.applyCompletion([start], 0, start.length - 1, menu.items[0], menu.prefix), {
    lines: [start], cursorLine: 0, cursorCol: start.length - 1,
  });
  const selected = wrapped.applyCompletion([start], 0, start.length, menu.items[0], menu.prefix);
  const next = "/setmodel:2 lab/reasoner ";
  assert.deepEqual(selected, { lines: [next], cursorLine: 0, cursorCol: next.length });
  assert.deepEqual(accepted, [[selected, true]]);
  const thinking = await wrapped.getSuggestions([next], 0, next.length, { signal });
  assert.deepEqual(thinking, { prefix: "lab/reasoner ", items: levels("off", "high", "max") });
  const final = wrapped.applyCompletion([next], 0, next.length, thinking.items[2], thinking.prefix);
  assert.equal(final.lines[0], "/setmodel:2 lab/reasoner max");
  assert.deepEqual(accepted.at(-1), [final, false]);
  assert.equal(await wrapped.getSuggestions(final.lines, 0, final.cursorCol, opts), null);
});

test("provider delegates unrelated syntax, preserves right-hand text and respects cancellation", async () => {
  const calls = [];
  const previous = {
    triggerCharacters: ["#"],
    async getSuggestions(...args) { calls.push(args); return { prefix: "", items: [{ label: "file", value: "file" }] }; },
    applyCompletion: native.applyCompletion.bind(native),
    shouldTriggerFileCompletion() { return false; },
  };
  const accepted = [];
  const wrapped = createSetmodelAutocompleteProvider(previous, "setmodel:2", suggest, (...args) => accepted.push(args));
  const options = { signal, force: true };
  assert.deepEqual(wrapped.triggerCharacters, ["#"]);
  for (const line of ["/setmodel:1 x", "/else x", "@some-file", "./file", "/setmo"]) {
    assert.equal((await wrapped.getSuggestions([line], 0, line.length, options)).items[0].value, "file");
    assert.equal(wrapped.shouldTriggerFileCompletion([line], 0, line.length), false);
  }
  assert.equal(calls.length, 5);
  const line = "/setmodel:2 lab/reasoner max";
  assert.equal(await wrapped.getSuggestions([line], 0, line.length - 2, options), null);
  assert.equal(wrapped.shouldTriggerFileCompletion([line], 0, line.length - 2), false);
  assert.equal(await wrapped.getSuggestions([line, "extra"], 0, line.length, options), null);
  const short = "/setmodel:2 ";
  assert.equal(await wrapped.getSuggestions([short], 0, short.length, { signal: AbortSignal.abort() }), null);
  assert.equal(wrapped.shouldTriggerFileCompletion([short], 0, short.length), true);
  const result = wrapped.applyCompletion(["/setmo"], 0, 6, { value: "setmodel:2", label: "setmodel:2" }, "/setmo");
  assert.equal(result.lines[0], short);
  assert.deepEqual(accepted, [[result, true]]);
  const file = wrapped.applyCompletion(["@f tail"], 0, 2, { value: "@file", label: "file" }, "@f");
  assert.equal(file.lines[0], "@file  tail");
  assert.equal(accepted.length, 1);
  assert.equal(calls.length, 5);
});

function mockPi() {
  const events = {};
  const effects = [];
  let command;
  createExtension({
    on(name, cb) { events[name] = cb; },
    registerCommand(name, options) { command = { name, ...options }; },
    getCommands() {
      return [{ name: "setmodel:2", source: "extension", sourceInfo: {
        path: new URL("./extensions/setmodel.ts", import.meta.url).pathname,
      } }];
    },
    async setModel(model) { effects.push(model.id); return true; },
    setThinkingLevel(level) { effects.push(level); },
  });
  return { events, command, effects };
}

test("public callback fallback and shutdown", () => {
  const { events, command } = mockPi();
  events.session_start({}, { mode: "rpc", ...source });
  assert.deepEqual(command.getArgumentCompletions(" lab/reasoner "), levels("off", "high", "max"));
  events.session_shutdown();
  assert.equal(command.getArgumentCompletions(""), null);
});

test("existing custom editor is not replaced; manual Tab works and old session stops", async () => {
  const { events } = mockPi();
  let wrap;
  events.session_start({}, { mode: "tui", ...source, ui: {
    addAutocompleteProvider(factory) { wrap = factory; },
    getEditorComponent() { return () => {}; },
    setEditorComponent() { assert.fail("must not replace existing editor"); },
  } });
  const wrapped = wrap(native);
  const line = "/setmodel:2 rsnr";
  assert.deepEqual((await wrapped.getSuggestions([line], 0, line.length, { signal, force: true })).items, [reasoner]);
  events.session_shutdown();
  assert.equal(await wrapped.getSuggestions([line], 0, line.length, { signal, force: true }), null);
});

test("submission validates arguments independently and persists only defaults", async () => {
  const { command, effects } = mockPi();
  const notifications = [];
  const ctx = { ...source, ui: { notify(...args) { notifications.push(args); } } };
  const dir = await mkdtemp(join(tmpdir(), "setmodel-test-"));
  const path = join(dir, "settings.json");
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeFile(path, '{"keep":true}');
    await command.handler('"lab/reasoner" high', ctx);
    await command.handler("lab/reasoner max extra", ctx);
    await command.handler("lab/reasoner low", ctx);
    assert.deepEqual(effects, []);
    assert.deepEqual(notifications.map(([, type]) => type), ["error", "warning", "error"]);
    await command.handler("lab/reasoner", ctx);
    assert.deepEqual(effects, ["reasoner", "max"]);
    await command.handler("  lab/reasoner  HIGH  ", ctx);
    assert.deepEqual(effects, ["reasoner", "max", "reasoner", "high"]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      keep: true, defaultProvider: "lab", defaultModel: "reasoner", defaultThinkingLevel: "high",
    });
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(dir, { recursive: true, force: true });
  }
});
