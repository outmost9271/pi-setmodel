/**
 * pi-setmodel — 在 pi-agent TUI 中提供 /setmodel 命令
 *
 * 用法：
 *   /setmodel <model>                设置模型（使用该模型支持的最高思考等级）
 *   /setmodel <model> <thinking>     设置模型与思考等级
 *
 * 行为：
 *   - <model> 匹配规则与 /model 一致：支持 "provider/id" 或裸 id（跨 provider
 *     有歧义时拒绝），补全时插入 "provider/id" 和下一阶段的分隔空格。
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

import { CONFIG_DIR_NAME, CustomEditor, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type Model,
  type ModelThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type EditorComponent,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  } catch {
    // Windows 上 rename 覆盖已存在文件可能失败，回退为直接写入。
    try {
      writeFileSync(path, content, "utf-8");
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 模型匹配与补全（与内置 /model 的 findExactModelReferenceMatch + 补全行文一致）
// ---------------------------------------------------------------------------

/** 从会话范围或模型注册表的内存快照读取，不在补全时查询凭据或网络。 */
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

/** 模型候选沿用 /model 的模糊搜索与展示方式，值附加下一阶段的分隔空格。 */
function modelCompletions(models: readonly Model<Api>[], prefix: string): AutocompleteItem[] | null {
  if (models.length === 0 || findExactModelMatch(prefix, models)) return null;
  const items = models.map((model) => ({ id: model.id, provider: model.provider, name: model.name }));
  const filtered = fuzzyFilter(items, prefix, getModelSearchText);
  if (filtered.length === 0) return null;
  return filtered.map((model) => ({
    value: `${model.provider}/${model.id} `,
    label: model.id,
    description: model.provider,
  }));
}

/** 返回完整参数值，与宿主的整段替换契约一致。查询可规范化，替换前缀不能。 */
export function argumentCompletions(source: ModelsSource | undefined, raw: string): AutocompleteItem[] | null {
  // 命令语法没有引号或转义：与执行一致，按空白分词，不去掉引号。
  const input = raw.trimStart();
  const match = /^(\S+)\s+(.*)$/.exec(input);
  const models = collectModels(source);
  if (!match) return /\s/.test(input) ? null : modelCompletions(models, input);

  const [, modelRef, rest] = match;
  const model = findExactModelMatch(modelRef, models);
  const query = rest.trim().toLowerCase();
  if (!model || /\s/.test(query)) return null;
  const levels = getSupportedThinkingLevels(model);
  // 已输完有效等级时让回车直接执行，而不是再次接受一个等值候选。
  if (levels.some((level) => level === query)) return null;
  const items = levels.filter((level) => level.startsWith(query))
    .map((level) => ({ value: `${modelRef} ${level}`, label: level }));
  return items.length ? items : null;
}

function getArguments(line: string, command: string): string | undefined {
  const text = line.trimStart();
  const start = `/${command}`;
  return text.startsWith(start) && /^[ \t]$/.test(text.charAt(start.length))
    ? text.slice(start.length + 1)
    : undefined;
}

type CompletionResult = ReturnType<AutocompleteProvider["applyCompletion"]>;

/** 仅接管自己的参数，包括宿主路由到强制路径补全的显式 Tab。 */
export function createSetmodelAutocompleteProvider(
  current: AutocompleteProvider,
  command: string,
  suggest: (raw: string) => AutocompleteItem[] | null,
  afterApply: (result: CompletionResult, hasMoreArguments: boolean) => void,
): AutocompleteProvider {
  const ownItems = new WeakSet<AutocompleteItem>();
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, line, col, options) {
      const text = lines[line] ?? "";
      const raw = getArguments(text, command);
      if (raw === undefined) return current.getSuggestions(lines, line, col, options);
      // 仅在单行末尾提供参数补全，不会吞掉或重复光标右侧的文本。
      if (options.signal.aborted || lines.length !== 1 || col !== text.length) return null;
      const items = suggest(raw);
      if (!items?.length) return null;
      for (const item of items) ownItems.add(item);
      return { prefix: raw, items };
    },
    applyCompletion(lines, line, col, item, prefix) {
      const text = lines[line] ?? "";
      if (ownItems.has(item)) {
        if (lines.length !== 1 || col !== text.length || getArguments(text, command) !== prefix) {
          return { lines, cursorLine: line, cursorCol: col };
        }
        const next = text.slice(0, col - prefix.length) + item.value;
        const result = { lines: [next], cursorLine: line, cursorCol: next.length };
        afterApply(result, item.value.endsWith(" "));
        return result;
      }
      const result = current.applyCompletion(lines, line, col, item, prefix);
      if (prefix.startsWith("/") && item.value === command && result.lines.length === 1 &&
          result.cursorCol === result.lines[0].length && getArguments(result.lines[0], command) === "") {
        afterApply(result, true);
      }
      return result;
    },
    shouldTriggerFileCompletion(lines, line, col) {
      const text = lines[line] ?? "";
      if (getArguments(text, command) !== undefined) return lines.length === 1 && col === text.length;
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  };
}

// Pi 1.6 尚无公开的普通补全刷新接口。其他版本或不兼容的编辑器仍可按 Tab 查询参数。
const supportsRefreshShim = /^1\.6\./.test(VERSION);

type CompletionEditor = EditorComponent & {
  focused?: boolean;
  getCursor?: () => { line: number; col: number };
  tryTriggerAutocomplete?: () => void;
};
type AfterApply = (result: CompletionResult, hasMoreArguments: boolean) => void;

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function setmodelExtension(pi: ExtensionAPI): void {
  let modelsSource: ModelsSource | undefined;
  let stopSession: (() => void) | undefined;
  const suggest = (raw: string) => argumentCompletions(modelsSource, raw);

  pi.on("session_start", (_event, ctx) => {
    stopSession?.();
    modelsSource = ctx;
    if (ctx.mode !== "tui") return;

    const path = canonicalPath(fileURLToPath(import.meta.url));
    const command = pi.getCommands().find((entry) => entry.source === "extension" &&
      /^setmodel(?::\d+)?$/.test(entry.name) && canonicalPath(entry.sourceInfo.path) === path)?.name;
    if (!command) return;

    let active = true;
    let afterApply: AfterApply = () => {};
    const isArgumentContext = (text: string) => !text.includes("\n") && getArguments(text, command) !== undefined;
    stopSession = () => { active = false; };
    ctx.ui.addAutocompleteProvider((current) => createSetmodelAutocompleteProvider(
      current, command, (raw) => active ? suggest(raw) : null, (result, more) => afterApply(result, more),
    ));

    if (!supportsRefreshShim || typeof ctx.ui.getEditorComponent !== "function") return;

    const previous = ctx.ui.getEditorComponent();
    const installed = new WeakMap<object, AfterApply>();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const component: EditorComponent = previous?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const editor = component as CompletionEditor;
      const existing = installed.get(editor);
      afterApply = existing ?? (() => {});
      if (!active || existing || typeof editor.focused !== "boolean" || typeof editor.getCursor !== "function" ||
          typeof editor.tryTriggerAutocomplete !== "function" || typeof editor.handleInput !== "function") return editor;
      const getCursor = editor.getCursor.bind(editor);
      const refresh = editor.tryTriggerAutocomplete.bind(editor);
      const handleInput = editor.handleInput.bind(editor);

      // 检查获得焦点的是不是同一个编辑器实例，而不是比较工厂函数：
      // 之后注册的扩展可以包装我们的工厂并继续使用同一个编辑器。
      const schedule = (text: string, line: number, col: number) => {
        queueMicrotask(() => {
          if (!active || !editor.focused || editor.getText() !== text) return;
          const cursor = getCursor();
          if (cursor.line === line && cursor.col === col) refresh();
        });
      };
      let accepted = false;
      editor.handleInput = (data) => {
        accepted = false;
        const before = editor.getText();
        handleInput(data);
        const text = editor.getText();
        const cursor = getCursor();
        // 手输、删除和粘贴使用同一解析；关闭菜单和移动光标不算编辑。
        if (active && !accepted && text !== before && cursor.col === text.length && isArgumentContext(text)) {
          schedule(text, cursor.line, cursor.col);
        }
      };
      afterApply = ({ lines, cursorLine, cursorCol }, more) => {
        if (!active || !editor.focused) return;
        accepted = true;
        // 等宿主提交文本并关闭旧菜单，再做非强制查询；不合成按键。
        if (more) schedule(lines.join("\n"), cursorLine, cursorCol);
      };
      installed.set(editor, afterApply);
      return editor;
    });
  });

  pi.on("session_shutdown", () => {
    stopSession?.();
    stopSession = undefined;
    modelsSource = undefined;
  });

  pi.registerCommand("setmodel", {
    description: "Set current and default model with optional thinking level",
    getArgumentCompletions: suggest,
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
