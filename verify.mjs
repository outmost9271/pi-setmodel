// 纯函数验证脚本（jiti 加载扩展模块）
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createJiti } = require("./node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./extensions/setmodel.ts");

const { findExactModelMatch, modelCompletions, thinkingCompletions, getModelSearchText } = mod;
const { getSupportedThinkingLevels } = await jiti.import("@earendil-works/pi-ai");

const base = {
  api: {},
  baseUrl: "https://example.com",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 16000,
};

const models = [
  { ...base, provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true },
  { ...base, provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
  { ...base, provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } },
  { ...base, provider: "deepseek", id: "plain-1", name: "Plain 1", reasoning: false },
  { ...base, provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true },
  { ...base, provider: "openrouter", id: "openai/gpt-5", name: "GPT-5 via OpenRouter", reasoning: true },
  { ...base, provider: "openrouter", id: "gpt-5", name: "GPT-5 duplicate", reasoning: true },
];

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  actual:   ${a}\n  expected: ${e}`}`);
}

// --- 1. 模型匹配（对齐 /model 的 findExactModelReferenceMatch） ---
check("canonical provider/id", findExactModelMatch("anthropic/claude-opus-4-8", models)?.id, "claude-opus-4-8");
check("bare id unique", findExactModelMatch("claude-sonnet-4-5", models)?.id, "claude-sonnet-4-5");
check("case-insensitive", findExactModelMatch("ANTHROPIC/CLAUDE-OPUS-4-8", models)?.id, "claude-opus-4-8");
check("ambiguous bare id", findExactModelMatch("gpt-5", models), undefined);
check("unknown", findExactModelMatch("nope/x", models), undefined);
check("empty", findExactModelMatch("   ", models), undefined);
check("id containing slash via openrouter", findExactModelMatch("openrouter/openai/gpt-5", models)?.id, "openai/gpt-5");

// --- 2. 模型补全（与 /model 相同的结构） ---
const comps = modelCompletions({ scopedModels: [], modelRegistry: { getAvailable: () => models } }, "");
check("empty prefix returns all", comps?.length, models.length);
check("completion item shape", comps?.[0], { value: "anthropic/claude-opus-4-8", label: "claude-opus-4-8", description: "anthropic" });
const fuzzy = modelCompletions({ scopedModels: [], modelRegistry: { getAvailable: () => models } }, "deepseek-v4");
check("fuzzy model filter", fuzzy?.map((c) => c.value), ["deepseek/deepseek-v4-pro"]);
check("search text format", getModelSearchText({ id: "x", provider: "p", name: "X Name" }), "x p p/x p x X Name");

// scoped 优先
const scopedComps = modelCompletions(
  { scopedModels: [{ model: models[2] }], modelRegistry: { getAvailable: () => models } },
  "",
);
check("scoped models win", scopedComps?.map((c) => c.value), ["deepseek/deepseek-v4-pro"]);

// --- 3. 思考等级补全（依赖具体模型能力） ---
const source = { scopedModels: [], modelRegistry: { getAvailable: () => models } };
check("anthropic levels h prefix", thinkingCompletions(source, "anthropic/claude-opus-4-8", "h"), [{ value: "high", label: "high" }]);
check("anthropic levels empty prefix", thinkingCompletions(source, "anthropic/claude-opus-4-8", "")?.map((c) => c.value), ["off", "minimal", "low", "medium", "high"]);
check("deepseek thinkingLevelMap filters", thinkingCompletions(source, "deepseek/deepseek-v4-pro", "")?.map((c) => c.value), ["off", "high", "max"]);
check("non-reasoning model", thinkingCompletions(source, "deepseek/plain-1", "")?.map((c) => c.value), ["off"]);
check("unknown model no completions", thinkingCompletions(source, "nope/x", ""), null);
check("unsupported level prefix", thinkingCompletions(source, "deepseek/deepseek-v4-pro", "x"), null);

// --- 4. 最高等级选择（levels 最后一项） ---
check("max level for anthropic", getSupportedThinkingLevels(models[0]).at(-1), "high");
check("max level for deepseek-map", getSupportedThinkingLevels(models[2]).at(-1), "max");
check("max level for non-reasoning", getSupportedThinkingLevels(models[3]).at(-1), "off");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
