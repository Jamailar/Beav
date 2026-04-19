# Contributing To RedBox

本文件定义 RedBox 工作区的基础协作规则，重点是让改动能被后续维护者快速理解、验证和接手。

## Start Here

1. 先读 [README.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/README.md) 了解工作区边界。
2. 再读 [AGENTS.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/AGENTS.md) 和 [docs/README.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/README.md)。
3. 改具体模块前，先打开该目录旁边的 `README.md` 或 `*.README.md`。

## Repository Rules

- 产品统一命名为 `RedBox` / `redbox`。
- renderer 访问宿主能力统一走 `window.ipcRenderer`，不要在页面里散落原始 Tauri 调用。
- `src-tauri/src/main.rs` 只做装配和注册，新增业务优先下沉到 `commands/`、`runtime/`、`persistence/`、`scheduler/` 等模块。
- 页面切换和刷新默认遵守 stale-while-revalidate，不要把已有数据清空成全页 loading。
- 不要在全局锁内做文件 I/O、目录扫描、hydrate、索引构建或重序列化。

## Required Verification

- 改 renderer：至少手动打开对应页面，验证切换、刷新、错误回退。
- 改 `src/bridge` / `src/ipc` / `src-tauri/src/commands`：至少跑一次真实 bridge 调用。
- 改 runtime / events / skills / prompts：至少验证一次真实会话或任务执行。
- 改脚本：至少运行对应脚本一次，确认输出路径和错误提示可用。
- 改文档：补充相互链接，避免只有一篇孤立文档。

## Documentation Rule

下列情况必须同步写文档：

- 新增一级目录或核心子系统
- 新增复杂 IPC / event / workspace schema
- 新增高复杂运行时模式、工具包、技能或调度行为
- 修复一次会沉淀成工程约束的 bug

文档放置原则：

- 模块职责和改动规则：放在代码目录旁边
- 跨模块流程、开发手册、契约：放在 `docs/`
- AI 资产使用规则：放在 `prompts/`、`skills/`、`builtin-skills/` 邻近位置

## Recommended Change Flow

1. 读模块文档，确认边界。
2. 读入口文件，确认真实调用路径。
3. 做最小必要改动，不顺手重构无关代码。
4. 先验证真实行为，再补文档。
5. 若发现新规则，把规则写回对应 README 或 `docs/`。

## Release Hygiene

- 版本号以根 [package.json](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/package.json) 为准。
- Rust 版本同步由 [scripts/sync-version.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/sync-version.mjs) 处理。
- 打包和运行方式见 [docs/development/setup.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/development/setup.md)。
