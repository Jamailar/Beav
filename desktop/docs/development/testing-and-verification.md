# Testing And Verification

Status: Current

## Goal

本仓库自动化测试还不完整，因此每次改动必须附带最小可执行验证。

## Baseline

```bash
pnpm build
cd src-tauri && cargo fmt --check && cargo check
```

## By Change Type

- 页面/UI：
  - 打开对应页面
  - 验证切换、刷新、错误回退
  - 验证旧数据不会因刷新被清空
- IPC / bridge：
  - 从页面或控制台触发一次真实调用
  - 验证 timeout/fallback/normalize
- runtime / events：
  - 发起一次真实对话或任务
  - 验证流式文本、工具、done 事件
- team collaboration：
  - `cd src-tauri && cargo test collab_`
  - `cd src-tauri && cargo test team_tool_`
  - `cd src-tauri && cargo test team_mcp_`
  - `cd src-tauri && cargo test subagent_spawn_creates_child_task_and_session_links`
  - `cd src-tauri && cargo test app_cli_schema_exposes_team_coordinator_actions`
  - 打开 Workboard 的 Collaboration 模式，验证 session 切换、member roster、Kanban、report request、内部成员创建、智能分配、阻塞上报、产物附加、完成声明和 stale-while-revalidate
  - 在主 AI 对话中要求“创建一个协作项目，包含 2 个内部成员和任务看板”，验证 AI 使用 `Operate(resource="team.session"|"team.member"|"team.task", operation=...)`
  - 通过 `Operate(resource="runtime", operation="team.mcpContract")` 验证 team MCP 工具合同
- workspace / persistence：
  - 验证当前窗口立即可见
  - 验证重启后可恢复
- video / remotion：
  - 验证素材路径转换
  - 验证预览或导出至少一条路径

## Evidence

文档和提交说明中应至少说明：

- 运行了哪些命令
- 手动验证了哪个页面或流程
- 没有验证的部分是什么，以及为什么
