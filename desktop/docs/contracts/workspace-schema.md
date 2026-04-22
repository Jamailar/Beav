# Workspace Schema

Status: Current

## Scope

本文件描述 RedBox workspace 的主要目录职责和谁负责读写这些目录。它不是完整文件格式手册，但用于指导维护者找到正确模块。

## Main Writers

- Host hydrate/read: `src-tauri/src/workspace_loaders.rs`
- Host persistence glue: `src-tauri/src/persistence/`
- Feature-specific writes: `knowledge.rs`、`manuscript_package.rs`、相关 commands/runtime

## Workspace Areas

- `subjects/`: 主体与素材主体数据
- `advisors/`: 顾问与成员资料
- `media/`: 媒体资源
- `cover/`: 封面资源
- `knowledge/`: 知识库文件与来源
- `redclaw/`: RedClaw 项目、任务、调度相关状态
- `.redbox/index/`: 知识索引运行时产物

## Rules

- renderer 不直接扫描 workspace。
- 命令层不重复实现 hydrate。
- 改 workspace 结构前，必须同步：
  - `workspace_loaders.rs`
  - `persistence/`
  - 对应模块 README
  - 如有用户可见影响，再补 `docs/`

## Verification

- 当前窗口内立即可见
- 重启后可恢复
- 切换空间后能重新 hydrate
- 失败时不会把已有 UI 清空
