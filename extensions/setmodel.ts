/**
 * pi-setmodel — 在 pi-agent TUI 中提供 /setmodel 命令
 *
 * 用法：
 *   /setmodel <model>                设置模型（使用该模型支持的最高思考等级）
 *   /setmodel <model> <thinking>     设置模型与思考等级
 *
 * 行为：
 *   - <model> 匹配规则与 /model 一致：支持 "provider/id" 或裸 id（跨 provider
 *     有歧义时拒绝），补全的 value 为 "provider/id"。
 *   - [thinking] 可选；省略时使用该模型支持的最高思考等级。
 *   - 思考等级会做依赖模型的能力校验（含 thinkingLevelMap 过滤），补全列表
 *     只列出"这个供应商的这个模型"实际支持的等级。
 *   - 执行成功后同时把默认模型/供应商/思考等级写入 settings.json
 *     （defaultProvider / defaultModel / defaultThinkingLevel）。
 *
 * 配置文件路径不硬编码：与 pi 内置 getAgentDir() 相同规则 ——
 * 优先 PI_CODING_AGENT_DIR 环境变量（支持 ~ 展开），缺省
 * ~/pi 配置目录名 + /agent（CONFIG_DIR_NAME 由 pi 包导出，品牌可换名）。
 */

import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type Model,
  type ModelThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// 配置文件路径（对齐 pi 内置 getAgentDir / getSettingsPath 的解析规则）
// ---------------------------------------------------------------------------

function expandTilde(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  return envDir ? expandTilde(envDir) : join(homedir(), CONFIG_DIR_NAME, "agent");
}

function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

interface SettingsFile {
  [key: string]: unknown;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ModelThinkingLevel;
}

/** 读写 settings.json 的默认模型/思考等级字段（仅更新这三个键，保留其余配置）。 */
function persistDefaults(providerId: string, modelId: string, level: ModelThinkingLevel): void {
  const path = getSettingsPath();
  let settings: SettingsFile = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8") || "{}");
    settings =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SettingsFile) : {};
  }
  settings.defaultProvider = providerId;
  settings.defaultModel = modelId;
  settings.defaultThinkingLevel = level;

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    // Windows 上 rename 覆盖已存在文件可能失败，回退为直接写入。
    try {
      writeFileSync(path, content, "utf-8");
    } finally {
      rmSync(tmp, { force: true });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 模型匹配与补全（与内置 /model 的 findExactModelReferenceMatch + 补全行文一致）
// ---------------------------------------------------------------------------

/** 补全用模型来源（ctx 与 session_start 缓存快照共享同一结构）。 */
interface ModelsSource {
  scopedModels: readonly { model: Model<Api> }[];
  modelRegistry: { getAvailable(): Model<Api>[] };
}

export function collectModels(source: ModelsSource | undefined): Model<Api>[] {
  if (!source) return [];
  if (source.scopedModels.length > 0) return source.scopedModels.map((scoped) => scoped.model);
  return source.modelRegistry.getAvailable();
}

/** 与 pi 内置 findExactModelReferenceMatch 相同的匹配语义。 */
export function findExactModelMatch(reference: string, models: readonly Model<Api>[]): Model<Api> | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();

  const canonicalMatches = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmed.slice(0, slashIndex).trim();
    const modelId = trimmed.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = models.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }

  const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

/** 与内置 /model 参数补全相同的搜索文本。 */
export function getModelSearchText(item: { id: string; provider: string; name: string }): string {
  const { id, provider } = item;
  const name = item.name ? ` ${item.name}` : "";
  return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/** 模型补全：与 /model 完全相同的项结构（value=provider/id、label=id、description=provider）。 */
export function modelCompletions(source: ModelsSource | undefined, prefix: string): AutocompleteItem[] | null {
  const models = collectModels(source);
  if (models.length === 0) return null;
  const items = models.map((model) => ({ id: model.id, provider: model.provider, name: model.name }));
  const filtered = fuzzyFilter(items, prefix, getModelSearchText);
  if (filtered.length === 0) return null;
  return filtered.map((model) => ({
    value: `${model.provider}/${model.id}`,
    label: model.id,
    description: model.provider,
  }));
}

/** 思考等级补全：只列"该模型"实际支持的等级（经 getSupportedThinkingLevels 过滤）。 */
export function thinkingCompletions(
  source: ModelsSource | undefined,
  modelRef: string,
  levelPrefix: string,
): AutocompleteItem[] | null {
  const model = findExactModelMatch(modelRef, collectModels(source));
  if (!model) return null;
  const levels = getSupportedThinkingLevels(model);
  const query = levelPrefix.trim().toLowerCase();
  const filtered = query ? levels.filter((level) => level.startsWith(query)) : levels;
  if (filtered.length === 0) return null;
  return filtered.map((level) => ({ value: level, label: level }));
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function setmodelExtension(pi: ExtensionAPI): void {
  // getArgumentCompletions 拿不到 ctx，在 session_start 时缓存最新模型快照。
  let modelsSource: ModelsSource | undefined;

  pi.on("session_start", (_event, ctx) => {
    modelsSource = { scopedModels: ctx.scopedModels, modelRegistry: ctx.modelRegistry };
  });

  pi.registerCommand("setmodel", {
    description: "Set current and default model with optional thinking level",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // 尚无空格：正在补全模型（与 /model 一致的模糊补全）
      if (!/\s/.test(prefix)) {
        return modelCompletions(modelsSource, prefix);
      }
      // 已有空格：第一段是模型引用，其余是思考等级前缀（依赖模型的能力列表）
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const modelRef = tokens[0];
      if (!modelRef) return null;
      return thinkingCompletions(modelsSource, modelRef, tokens.slice(1).join(" "));
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const modelRef = parts[0];
      const levelArg = parts[1];

      if (!modelRef) {
        ctx.ui.notify("Usage: /setmodel <model> [thinking-level]", "info");
        return;
      }
      if (parts.length > 2) {
        ctx.ui.notify("Too many arguments. Usage: /setmodel <model> [thinking-level]", "warning");
        return;
      }

      // 模型解析与 /model 相同：scoped 模型存在时只在 scoped 中匹配
      const models = collectModels(ctx);
      const model = findExactModelMatch(modelRef, models);
      if (!model) {
        ctx.ui.notify(`Model "${modelRef}" not found. Use /model to see available models.`, "error");
        return;
      }

      const levels = getSupportedThinkingLevels(model);
      let level: ModelThinkingLevel;
      if (levelArg !== undefined) {
        const requested = levelArg.trim().toLowerCase() as ModelThinkingLevel;
        if (!levels.includes(requested)) {
          ctx.ui.notify(
            `Model ${model.provider}/${model.id} does not support thinking level "${levelArg}". Supported: ${levels.join(", ")}`,
            "error",
          );
          return;
        }
        level = requested;
      } else {
        // 未指定思考等级：使用该模型支持的最高等级
        level = levels[levels.length - 1];
      }

      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
        return;
      }
      pi.setThinkingLevel(level);

      try {
        persistDefaults(model.provider, model.id, level);
      } catch (error) {
        ctx.ui.notify(
          `Model set, but failed to save defaults: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Model: ${model.provider}/${model.id} · thinking: ${level} (saved as default)`, "info");
    },
  });
}
