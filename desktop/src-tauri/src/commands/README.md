# `commands/` 模块

## 职责

- 按业务域处理前端发起的 channel/IPC 请求。
- 将请求路由到 runtime、persistence、scheduler 与各能力模块。

## 子模块

- `advisor_ops`：顾问相关操作。
- `assistant_daemon`：助手守护进程控制。
- `bridge`：桥接层命令。
- `chat` / `chat_runtime` / `chat_state` / `chat_sessions_wander`：聊天与漫步会话链路。
- `chatrooms`：群聊房间。
- `embeddings`：向量与嵌入任务。
- `file_ops`：文件相关命令。
- `generation`：生成任务入口。
- `library`：知识库/素材库命令。
- `manuscripts`：稿件命令。
- `mcp_tools`：MCP 配置与调用命令。
- `official`：官方平台相关命令。
- `plugin`：插件相关命令。
- `redclaw` / `redclaw_runtime`：RedClaw 任务与运行态命令。
- `runtime` / `runtime_orchestration` / `runtime_routing`：运行时路由与编排命令。
- `skills_ai`：技能与 AI 相关命令。
- `spaces`：空间管理。
- `subjects`：主体管理。
- `system`：系统级命令。
- `wechat_official`：公众号命令。
- `workspace_data`：工作区数据命令。
