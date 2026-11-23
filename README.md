# pi-setmodel

pi-agent 扩展：在 TUI 中新增 `/setmodel` 命令，一条命令同时完成——

1. 切换当前会话的模型与思考等级；
2. 把默认模型/供应商/思考等级写入配置文件（`settings.json`），后续会话自动沿用。

## 安装

```bash
pi install git:github.com/outmost9271/pi-setmodel@v1.1.1
```

或本地路径调试：

```bash
pi install /absolute/path/to/pi-setmodel
```

## 用法

```
/setmodel <model> [thinking-level]
```

| 参数 | 说明 |
|------|------|
| `<model>` | 必选。`provider/model` 或裸模型 id（跨 provider 有歧义时拒绝），匹配规则与 `/model` 完全一致 |
| `[thinking-level]` | 可选。省略时使用该模型支持的最高思考等级 |

示例：

```
/setmodel anthropic/claude-sonnet-4-5          # 使用该模型最高思考等级
/setmodel anthropic/claude-sonnet-4-5 high     # 指定思考等级
/setmodel claude-sonnet-4-5 medium             # 裸 id 唯一时可省略 provider
```

## 补全

- 在 Pi 1.6 中，输入 `/setmod`，用 `Tab` 选中命令即可打开模型列表；选中模型后自动打开该模型的思考等级列表。手输精确模型后加空格、粘贴和继续编辑也使用同一套候选规则。
- 模型沿用 `/model` 的模糊匹配，插入 `provider/id`；思考等级按该模型的能力和 `thinkingLevelMap` 过滤。选中等级保留模型，不执行命令；再按回车才提交。命令名菜单上的回车仍按 Pi 原生规则提交裸命令。
- 手输完整模型可直接提交，使用最高支持等级；手输完整等级也不会出现重复候选。参数不支持引号或转义，参数补全仅在单行末尾提供，避免覆盖光标右侧的文本。
- 兼容沿用 Pi 编辑器的包装扩展（例如 `pi-ext`），不替换它们的编辑器。其他 Pi 版本或不兼容的编辑器仍可在命令参数处按 `Tab` 查询候选。其他命令、`@` 引用和普通路径仍由原提供器处理。

## 配置文件路径

不硬编码路径。默认模型/思考等级写入：

- `$PI_CODING_AGENT_DIR/settings.json`（设置该环境变量时，支持 `~` 展开）
- 否则 `~/.pi/agent/settings.json`（目录名取自 pi 导出的 `CONFIG_DIR_NAME`）

只更新 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 三个键，其余配置原样保留。

## 复用与实现说明

- 模型匹配逻辑逐句对齐 pi 内置 `findExactModelReferenceMatch`（`/model` 同一语义）；
- 候选使用公开的 `getArgumentCompletions` 契约，光标保护和显式 `Tab` 路由由提供器包装处理；Pi 1.6 的级联刷新经过版本与能力检测，在宿主提交编辑后查询，不模拟按键；
- 思考等级能力来自 `@earendil-works/pi-ai` 的 `getSupportedThinkingLevels(model)`；
- 状态切换复用 `pi.setModel()`（自带认证校验）与 `pi.setThinkingLevel()`；
- 写 settings.json 采用临时文件 + 原子重命名，避免写一半损坏配置。

## 开发

```bash
npm ci
npm test            # 类型、候选、提供器、会话与持久化测试（Node.js 22.18+）
```

真实终端回归（Linux 伪终端，需要 Python 和 `pyte==0.8.2`，传入实际 Pi 二进制路径）：

```bash
python verify-tty.py /absolute/path/to/pi
```

终端测试使用独立临时目录和离线模式，不读取真实配置或凭据。可额外传入 `setmodel.ts` 和 `pi-ext/extensions/index.ts` 的路径，验证两个扩展以不同顺序加载时的行为。

## 许可

MIT
