# pi-setmodel

pi-agent 扩展：在 TUI 中新增 `/setmodel` 命令，一条命令同时完成——

1. 切换当前会话的模型与思考等级；
2. 把默认模型/供应商/思考等级写入配置文件（`settings.json`），后续会话自动沿用。

## 安装

```bash
pi install git:github.com/outmost9271/pi-setmodel@v1.0.0
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

- 命令参数带补全：输入模型时与 `/model` 相同的模糊补全
  （`value=provider/id`、`label=id`、`description=provider`）；
- 模型 + 空格后，补全列表只显示**该供应商该模型实际支持**的思考等级
  （依据模型元数据与 `thinkingLevelMap` 过滤，不含其他模型都一样的固定列表）；
- 思考等级不合法时命令报错并列出该模型支持的等级。

## 配置文件路径

不硬编码路径。默认模型/思考等级写入：

- `$PI_CODING_AGENT_DIR/settings.json`（设置该环境变量时，支持 `~` 展开）
- 否则 `~/.pi/agent/settings.json`（目录名取自 pi 导出的 `CONFIG_DIR_NAME`）

只更新 `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 三个键，其余配置原样保留。

## 复用与实现说明

- 模型匹配逻辑逐句对齐 pi 内置 `findExactModelReferenceMatch`（`/model` 同一语义）；
- 模型补全项结构与搜索文本对齐内置 `/model` 参数补全（阈值、排序一致，`fuzzyFilter` 来自 `@earendil-works/pi-tui`）；
- 思考等级能力来自 `@earendil-works/pi-ai` 的 `getSupportedThinkingLevels(model)`；
- 状态切换复用 `pi.setModel()`（自带认证校验）与 `pi.setThinkingLevel()`；
- 写 settings.json 采用临时文件 + 原子重命名，避免写一半损坏配置。

## 开发

```bash
npm install        # 安装 devDependencies 用于类型检查
npx tsc --noEmit   # 类型检查（tsconfig.json）
```

## 许可

MIT
