# Testing And Verification

Status: Current

## Goal

本仓库自动化测试还不完整，因此每次改动必须附带最小可执行验证。

## Baseline

```bash
pnpm build
cd src-tauri && cargo fmt --check && cargo check
```

## Headless AI Runtime Probe

AI runtime / MCP / CLI / tool / team / skill / RedClaw / Wander 相关改动，应优先跑不依赖手点 UI 的 probe：

```bash
cd desktop/src-tauri
cargo run --bin redbox_runtime_probe -- smoke
cargo run --bin redbox_runtime_probe -- run-all --provider mock
cargo run --bin redbox_runtime_probe -- run-scenario wander-loop --provider mock
cargo run --bin redbox_runtime_probe -- run-scenario wander-to-creation --repeat 3 --provider mock
cargo run --bin redbox_runtime_probe -- run-scenario stream-retry --provider mock
cargo run --bin redbox_runtime_probe -- run-scenario stream-error-next-turn --provider mock
```

查看复盘：

```bash
cargo run --bin redbox_runtime_probe -- inspect --session <session_id>
cargo run --bin redbox_runtime_probe -- review-prompt --session <session_id>
cargo run --bin redbox_runtime_probe -- review-real --session <real_redbox_session_id>
```

当前 `run-scenario` / `run-all` 是 mock-contract 自动化底座，输出在 `desktop/src-tauri/target/runtime-probe/`，报告会标记 `probeMode: mock-contract` 和 `workspaceKind: probe-temp`。它验证协议、工具契约、streaming、保存摘要等边界，但不会启动真实 UI agent loop，也不会写真实用户稿件。

真实 app 已经跑出的会话用 `review-real` 审计。该命令读取 `~/Library/Application Support/RedBox/session-transcripts/` 和 `session-bundles/`，检查真实 run 是否读档案、读素材、创建稿件、调用 `Write(path="manuscripts://current")`，以及是否仍有 `.thrive` / `.redarticle` 旧格式残留。

如果需要从命令行触发真实 app loop，可以让 probe 自动拉起 Tauri dev app，等待 assistant daemon 监听 `127.0.0.1:31937` 后再走真实 IPC：

```bash
export REDBOX_TEST_AI_BASE_URL="https://api.example.test/v1"
export REDBOX_TEST_AI_API_KEY="..."
export REDBOX_TEST_AI_MODEL="..."

cargo run --bin redbox_runtime_probe -- invoke-real-ipc \
  --send \
  --start-app \
  --model-config-env \
  --require-model-config \
  --channel chat:send-message \
  --payload-json '{"message":"hi","displayContent":"hi"}'
```

如果桌面端已经运行，也可以直接连接现有 daemon：

```bash
cargo run --bin redbox_runtime_probe -- invoke-real-ipc \
  --send \
  --model-config-env \
  --require-model-config \
  --channel chat:send-message \
  --payload-json '{"message":"hi","displayContent":"hi"}'
```

这个命令会进入真实 `/api/ipc/send` / `chat:send-message`，因此应能在 provider 调用日志和真实 session transcript 中看到新增记录。若 daemon 未运行且没有传 `--start-app`，命令必须失败，不能回退到 mock。`--start-app` 的 app stdout/stderr 会写入 `desktop/src-tauri/target/runtime-probe/real-app-*/app.log`，用于复盘启动和 daemon 就绪问题。

真实 loop 的自动化测试不要依赖当前桌面端是否已登录。默认用 `--model-config-env --require-model-config` 从 `REDBOX_TEST_AI_BASE_URL`、`REDBOX_TEST_AI_API_KEY`、`REDBOX_TEST_AI_MODEL` 注入一次性测试模型配置；若缺配置，probe 会在调用 provider 前失败，避免把“测试环境未配置”误判成 agent loop 或 streaming 稳定性问题。

关键 agent loop 场景必须带 `idealLoop` 和 `loopReview`：先声明理想完成路径、应激活的技能、理想/最大工具调用次数，再用实际事件流和工具调用做差距复盘。`wander-loop` 和 `wander-to-creation` 是这套规则的基线场景。

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
