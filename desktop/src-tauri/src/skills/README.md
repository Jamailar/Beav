# `src-tauri/src/skills/`

本目录负责技能加载、权限、hooks、运行时接入和文件监听。

## Main Files

- `loader.rs`: 技能加载
- `permissions.rs`: 技能权限边界
- `hooks.rs`: 技能 hook
- `runtime.rs`: 技能运行时适配
- `watcher.rs`: 技能变更监听

## Rules

- 技能能力边界优先用权限和 runtime contract 表达，不要靠字符串启发式。
- 新技能加载行为要考虑 watcher 和 runtime 的一致性。
- 技能文件格式变化要同步 `builtin-skills/`、`skills/` 和相关文档。

## Related Docs

- [docs/skill-runtime-v2.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/skill-runtime-v2.md)
