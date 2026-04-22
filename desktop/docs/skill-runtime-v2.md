# Skill Runtime V2

本文件记录当前 RedBox 技能模块的运行时 contract，供维护、排障和后续扩展使用。

## 目标

Skill Runtime V2 的目标不是把技能继续当成静态 prompt 片段，而是把技能提升成可发现、可条件激活、可显式调用、可注册 hook、可落盘管理的一等运行时对象。

这轮实现对齐的关键能力：

- 动态发现：工作区、`~/.codex/skills`、`~/.agents/skills`
- 富 frontmatter：支持执行上下文、模型覆盖、路径条件、hooks、参数提示
- 请求级激活：按 `intent / contextType / touchedPaths / message / activeSkills`
- 显式调用：`skills:invoke`
- 激活预演：`skills:preview-activation`
- 文件型技能管理：创建、保存、启停直接落到 `SKILL.md`
- hook 生命周期：`turnStart`、`turnComplete`、`skillActivated`
- 使用统计：按 session checkpoint 聚合技能使用次数和最近使用时间

## 核心代码入口

- Loader: [src-tauri/src/skills/loader.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/loader.rs)
- Runtime resolver: [src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs)
- Hook matcher: [src-tauri/src/skills/hooks.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/hooks.rs)
- 技能命令面: [src-tauri/src/commands/skills_ai.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/skills_ai.rs)
- 工具入口: [src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs), [src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs), [src-tauri/src/tools/guards.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/guards.rs)
- 前端管理页: [src/pages/Skills.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Skills.tsx)
- Bridge/type: [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts), [src/types.d.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/types.d.ts)

## Frontmatter Contract

当前支持的关键 frontmatter 字段：

- `allowedRuntimeModes`
- `allowedToolPack`
- `allowedTools`
- `blockedTools`
- `autoActivate`
- `autoActivateWhenIntents`
- `autoActivateWhenContextTypes`
- `whenToUse`
- `aliases`
- `argumentHint`
- `arguments`
- `userInvocable`
- `disableModelInvocation`
- `model`
- `effort`
- `context`
- `agent`
- `paths`
- `hooks`
- `shell`
- `disabled`

示例：

```md
---
allowedRuntimeModes: [redclaw]
autoActivate: true
autoActivateWhenIntents: [manuscript_creation]
paths: [manuscripts/**]
context: fork
model: gpt-5
effort: high
argumentHint: 主题
arguments: [topic, tone]
hooks:
  turnStart:
    - matcher: redclaw
      hooks:
        - type: checkpoint
          summary: skill turn started
---
# Writing Style

根据 {{topic}} 生成更稳定的写作策略。
```

## 发现与落盘

技能发现顺序：

1. 当前工作区 `skills/`
2. `~/.codex/skills`
3. `~/.agents/skills`

技能创建和 market install 现在默认写入真实文件：

- 工作区优先写到 `<workspace>/skills/<slug>/SKILL.md`
- 无工作区时回退到 `~/.codex/skills/<slug>/SKILL.md`

启用和禁用不再只改内存状态，而是更新 frontmatter 中的 `disabled`。

## 激活规则

运行时会把以下输入统一送入 `SkillActivationContext`：

- `current_message`
- `intent`
- `touched_paths`
- `args`

并结合请求 metadata 做匹配：

- `intent`
- `contextType`
- `activeSkills`
- `associatedFilePath`
- `sourceManuscriptPath`
- `filePath`
- `path`
- `projectPath`

路径匹配既支持完整路径，也支持工作区绝对路径上的后缀段匹配，所以 `paths: [manuscripts/**]` 可以命中 `/workspace/foo/manuscripts/post.md`。

## 调用与预演

新增 IPC：

- `skills:invoke`
- `skills:preview-activation`

对应 bridge：

- `window.ipcRenderer.invokeSkill(...)`
- `window.ipcRenderer.previewSkillActivation(...)`

`skills:invoke` 的返回值会给出：

- `renderedPrompt`
- `executionContext`
- `modelOverride`
- `effortOverride`
- `allowedTools`
- `paths`
- `hooks`
- `referencesIncluded`
- `scriptsIncluded`
- `ruleCount`

`skills:preview-activation` 会返回：

- 当前 runtime 下的 `activeSkills`
- 聚合后的 `allowedTools`
- 聚合后的 `modelOverride`
- 聚合后的 `effortOverride`

## Hook 语义

当前已接入的事件：

- `turnStart`
- `turnComplete`
- `skillActivated`

当前 action 类型以 `checkpoint` 为主，会把 skill 生命周期写入 session checkpoint，便于 diagnostics 和后续自动化使用。

## 能力集与模型覆盖

skill 运行时不只影响 prompt，还会同步影响：

- tool 可见性
- canonical action 可见性
- capability set
- provider 侧 model/effort 选择

也就是说 skill 不再只是“提示词补丁”，而是完整参与运行时收敛。

## 工具引用规则

- `allowedTools` 只写 canonical top-level tool：`bash`、`redbox_fs`、`app_cli`、`redbox_editor`。
- skill 正文、`activationHint`、`contextNote`、prompt prefix/suffix 中，默认只写 canonical 调用形式：
  - `app_cli(action="...", payload={ ... })`
  - `redbox_fs(action="workspace.read" | "knowledge.search", payload={ ... })`
  - `redbox_editor(action="...", payload={ ... })`
- 不要在新 skill 里写 `app_cli(command="...")`、`knowledge_read`、`knowledge_grep`、`redbox_runtime_control` 这类 legacy 调用。
- 如果 runtime 仍需要兼容旧写法，应由 `tools/compat.rs` 负责翻译；skill 本身不负责教授兼容语法。
- 选择工具时，优先挑最小 action，不要把多步任务塞进一个模糊 action 描述里。

## 维护规则

- 新增技能字段，先扩 `SkillFrontmatterRecord` 和 `SkillMetadataRecord`，再扩前端类型。
- 新增 hook 类型，必须在 `src-tauri/src/agent/loop.rs` 或对应执行链里接入，不要只写 frontmatter。
- 新增 skill IPC 后，要同步更新 bridge、`src/types.d.ts` 和 `docs/ipc-inventory.md`。
- 路径条件一律走 runtime resolver，不要在页面或命令层复制字符串启发式。
- 若 skill 需要新增工具能力，先补 canonical action schema，再更新 skill 文本；不要先在 skill 里发明不存在的 tool 语法。

## 验证命令

```bash
cd /Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri && cargo check
cd /Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri && cargo test skills:: -- --nocapture
cd /Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri && cargo test agent::chat:: -- --nocapture
cd /Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri && cargo test agent::query:: -- --nocapture
cd /Users/Jam/LocalDev/GitHub/RedConvert/desktop && pnpm build
cd /Users/Jam/LocalDev/GitHub/RedConvert/desktop && pnpm ipc:inventory
```
