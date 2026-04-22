# `src/components/`

本目录放可复用 renderer 组件，包括通用 UI、对话框、消息展示，以及稿件/编辑器相关组件。

## Main Groups

- 通用组件：`Layout`、`ConfirmDialog`、`ErrorBoundary`、`AppDialogsHost`
- 聊天/runtime 组件：`MessageItem`、`ThinkingBubble`、`ProcessTimeline`
- 稿件/编辑器组件：见 `components/manuscripts/`
- 页面局部组件：如 `components/wander/`

## Rules

- 页面私有编排先留在页面，确认复用后再下沉。
- 复杂编辑器组件应带清晰输入输出，不把 host 访问直接塞进深层组件。
- 如组件依赖重状态或大数据，优先由页面层做裁剪和归一化。

## Verification

- 复用组件改动后，至少检查两个使用场景
- 对话框和编辑器类组件要验证键盘、滚动和错误回退
