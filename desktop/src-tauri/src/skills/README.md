# `src-tauri/src/skills/`

本目录负责技能加载、包级元数据、资源索引、权限、hooks、运行时接入和文件监听。

## Main Files

- `loader.rs`: 技能加载
- `package.rs`: Skill V3 包视图，统一 `skill.json`、legacy frontmatter、Codex `agents/openai.yaml`、市场 provenance、资源索引和 audit warnings
- `resources.rs`: `skill://<skill>/<path>` 资源读取和目录安全边界
- `permissions.rs`: 技能权限边界
- `hooks.rs`: 技能 hook
- `runtime.rs`: 技能运行时适配
- `watcher.rs`: 技能变更监听

## Rules

- 技能能力边界优先用权限和 runtime contract 表达，不要靠字符串启发式。
- `SkillRecord` 只作为兼容 DTO；面向产品、市场、审计和 agent 工具的结构化真值应走 `SkillPackageRecord`。
- 资源内容按需读取；catalog / inspect 默认暴露 resource tree、hash、大小和 provenance，不把 references/scripts 全量塞入 prompt。
- 新技能加载行为要考虑 watcher 和 runtime 的一致性。
- 技能文件格式变化要同步 `builtin-skills/`、`skills/` 和相关文档。

## Related Docs

- [docs/skill-runtime-v2.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/skill-runtime-v2.md)
