# Skill Runtime V2

本文件记录当前 RedBox 技能模块的运行时 contract，供维护、排障和后续扩展使用。

## 目标

Skill Runtime V2 的目标不是把技能继续当成静态 prompt 片段，也不是让模型先调用一个工具再猜测技能规则，而是把技能提升成可发现、可结构化选择、可在采样前显式注入、可审计的一等运行时对象。

这轮实现对齐的关键能力：

- 动态发现：工作区、`~/.codex/skills`、`~/.agents/skills`
- 富 frontmatter：支持 runtime mode、工具权限、hook mode、prompt prefix/suffix、activation scope
- 结构化选择：`@skill` / task hints / session metadata 进入 `sessionSkillState` 与 `activeSkills`
- 采样前注入：本轮 active skill 会以 Codex 形态的 `<skill>` user context block 注入模型请求
- 兼容调用：`skills:invoke` 仍可作为 fallback，但不再是主激活路径
- 文件型技能管理：创建、保存、启停直接落到 `SKILL.md`
- 使用统计：记录 skill invocation metric、`skill.instruction` transcript 和 session bundle

## 核心代码入口

- Loader: [src-tauri/src/skills/loader.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/loader.rs)
- Runtime resolver: [src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs)
- Hook matcher: [src-tauri/src/skills/hooks.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/hooks.rs)
- Instruction injection: [src-tauri/src/skills/injection.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/injection.rs)
- Runtime message injection: [src-tauri/src/host_impl.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/host_impl.rs)
- 技能命令面: [src-tauri/src/commands/skills_ai.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/skills_ai.rs)
- 工具入口: [src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs), [src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs), [src-tauri/src/tools/guards.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/guards.rs)
- 前端管理页: [src/pages/Skills.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Skills.tsx)
- Bridge/type: [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts), [src/types.d.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/types.d.ts)

## Frontmatter Contract

当前运行时实际解析的关键 frontmatter 字段：

- `allowedRuntimeModes`
- `allowedToolPack`
- `allowedTools`
- `blockedTools`
- `autoActivate`
- `hookMode`
- `activationScope`
- `promptPrefix`
- `promptSuffix`
- `contextNote`
- `activationHint`
- `maxPromptChars`
- `hidden`

示例：

```md
---
allowedRuntimeModes: [redclaw, wander]
allowedTools: [workflow, editor]
autoActivate: false
activationScope: turn
hookMode: inline
activationHint: when the user asks for a high-retention video script
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

## 激活与注入

主路径对齐 Codex：

1. 前端 `@skill` / shortcut 会把技能名写入 `taskHints.activeSkills`。
2. chat send 将 task hints 合并到 session metadata，并写入 `sessionSkillState`。
3. `resolve_skill_set` 生成本轮 active skill 快照。
4. `interactive_runtime_message_bundle` 在当前用户消息后追加 `<skill>` user context block。
5. provider 转换器只读取 `role/content`，所以 OpenAI、Anthropic、Gemini 都会收到同一份 `SKILL.md` 正文。
6. 注入内容同时进入 canonical bundle，并写入 `skill.instruction` transcript 记录。

注入格式：

```xml
<skill>
<name>high-retention-video-script</name>
<path>/absolute/path/to/SKILL.md</path>
...完整 SKILL.md...
</skill>
```

如果同一份 skill 指令已经存在于当前历史消息中，runtime 不会重复追加，避免长会话无限膨胀。若历史被压缩或 skill 正文变化，下一轮会重新注入。

## 选择规则

运行时结合请求 metadata 做匹配：

- `activeSkills`
- `sessionSkillState.requested`
- `sessionSkillState.active`
- `taskHints.activeSkills`
- `memberSkillRef`

turn-scoped skill 只有在本轮 `taskHints` 显式请求时才会激活；session-scoped skill 可以随 session metadata 保持 active。

## 调用与预演

当前 IPC：

- `skills:invoke`
- `skills:list`
- `skills:inspect`
- `skills:list-resources`
- `skills:read-resource`

对应 bridge：

- `window.ipcRenderer.invokeSkill(...)`

`skills:invoke` 是兼容 fallback：当模型从 catalog 判断需要某个未注入 skill 时，可以调用它请求激活并拿到 `skillContextPack`。正常 `@skill` 流程不依赖它。

`skills:invoke` 的返回值会给出：

- `activeSkills`
- `activationTransition`
- `hydrationStatus`
- `skillContextPack`
- `skillContextPack.body`: 当前 `SKILL.md` 正文，按安全上限截断
- `skillContextPack.package`: 技能包 manifest、resource index、provenance 与校验信息
- `skillContextPack.referencedResources`: `SKILL.md` 直接引用的 `references/`、`rules/`、`templates/`、`scripts/`、`assets/` 资源读取结果
- `skillContextPack.resourceErrors`: 资源缺失、非文本资源或读取失败的显式错误
- `skillContextPack.executionContract`: 模型继续执行前必须遵守的技能使用边界
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

`activeSkills` 只表示技能已被选择，不代表技能规则已经被遵守。主路径以 `<skill>` 注入的 `SKILL.md` 为准；fallback 工具路径以 `skillContextPack` 为准。如果正文或引用资源缺失，下一步必须用 `skills:read-resource` / `Read(skill://...)` 补齐，而不是直接按技能名猜测规则。

## 能力集

skill 运行时不只影响 prompt，还会同步影响：

- tool 可见性
- canonical action 可见性
- capability set

也就是说 skill 不再只是“提示词补丁”，而是完整参与运行时收敛。

## 工具引用规则

- `allowedTools` 只写 canonical top-level tool：`bash`、`resource`、`workflow`、`editor`。
- skill 正文、`activationHint`、`contextNote`、prompt prefix/suffix 中，默认只写模型可见调用形式：
  - `Operate(resource="...", operation="...", input={ ... })`
  - `Read(path="workspace://...")`
  - `Search(path="knowledge://", query="...")`
  - `Write(path="editor://current/script", content="...")`
- 不要在新 skill 里写 `workflow(command="...")`、`knowledge_read`、`knowledge_grep`、`runtime_control` 这类 legacy 调用。
- runtime 不再教授旧写法；skill 本身也不负责兼容语法。
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
