---
doc_type: plan
execution_status: completed
last_updated: 2026-04-24
---

# CLI Runtime Discovery / Resolve / Execute Upgrade Plan

## 1. 背景

当前 RedBox 的 CLI Runtime 已经具备基础能力：

- `cli_runtime.detect`
- `cli_runtime.inspect`
- `cli_runtime.install`
- `cli_runtime.execute`
- environment / installer / verification / event 回流

但实际使用中仍然存在结构性问题：

1. `detect` 只探测一小组默认命令，不是全 PATH 枚举。
2. agent 容易把“没在 detect 里看到”误判成“系统没装”。
3. 失败后 agent 会回退到只读 `bash` 做 `which` / `command -v` / `echo $PATH` 诊断，得到失真结果。
4. `cwd`、PATH、安装目标、受管环境这几个概念在产品上没有清楚拆开。
5. 用户电脑里已经存在的 npm/cargo/go 全局 CLI，缺少统一、稳定、可解释的发现路径。

这份计划的目标不是修 `lark-cli` 个案，而是把 RedBox 的 CLI Runtime 升级成真正可用的：

- Discovery
- Resolve
- Execute
- Diagnose
- Install

控制面。

## 2. 目标

升级完成后，系统必须满足：

1. 用户机器上已经存在的 CLI，即使不在默认 detect 名单中，也可以被发现和解析。
2. agent 不再把 `detect` 当作“是否已安装”的唯一依据。
3. CLI 可见性诊断不再依赖 `bash`。
4. UI 能明确展示：
   - CLI 从哪里被解析出来
   - 当前执行工作目录是什么
   - 当前生效 PATH 是什么
   - 为什么没识别到
5. 视频链路里的 `ffmpeg` / `ffprobe` / `remotion` 也遵守同一套解析与执行模型。

## 3. 方案对比

### 方案 A：继续往默认探测名单里加工具

做法：

- 在 `default_detect_commands()` 里持续追加：
  - `lark-cli`
  - `vercel`
  - `ollama`
  - `turbo`
  - `supabase`
  - 更多 CLI

优点：

- 开发快
- 改动小

缺点：

- 永远是追着用户机器上的工具补洞
- 不适合长尾 CLI 生态
- agent 仍然容易把 `detect` 误当“系统真实状态”

结论：

- 不推荐

### 方案 B：放开 bash 做 PATH 诊断

做法：

- 允许 `bash` 跑：
  - `which`
  - `command -v`
  - `echo $PATH`

优点：

- 表面上很快
- 诊断能力立刻变强

缺点：

- 重新把 CLI 发现交给裸 shell
- 安全和可观测性倒退
- 仍然依赖模型自己理解 shell 输出
- 与当前 CLI Runtime 控制面冲突

结论：

- 不推荐

### 方案 C：升级成真正的 Discovery / Resolve / Execute 控制面

做法：

- `detect` 只做快速概览
- 新增 `discover`
- `inspect` 负责精确解析
- agent 路由改成：
  - 已知命令先 `inspect`
  - 不确定命令再 `discover`
- 不再使用 `bash` 诊断 PATH

优点：

- 一次性做对
- 对任何本机 CLI 都通用
- 可解释、可调试、可验证

缺点：

- 工程量更大

结论：

- 推荐方案

## 4. 产品架构

升级后 CLI Runtime 拆成 6 层。

### 4.1 Discovery Layer

职责：

- 发现宿主机器上可能存在的 CLI
- 提供快速概览和全量搜索两种能力

能力拆分：

- `detect`
  - 面向首页和常用工具状态
  - 只看默认命令集 + 已登记环境
- `discover`
  - 面向真实 PATH 搜索
  - 支持 query / limit
- `inspect`
  - 面向单个命令的精确解析与诊断

### 4.2 Resolve Layer

职责：

- 解释一个 CLI 是从哪里被解析出来的

必须输出：

- `resolvedPath`
- `resolvedFrom`
  - `host-shell-path`
  - `extra-bin-path`
  - `managed-environment`
  - `explicit-path`
- `effectivePathPreview`
- `versionProbeSucceeded`
- `isInDefaultDetectCatalog`

### 4.3 Environment Layer

职责：

- 清楚地区分：
  - 工具从哪解析
  - 命令在哪执行
  - 安装装到哪

环境类型：

- `host-visible`
- `app-global`
- `workspace-local`
- `task-ephemeral`

### 4.4 Execution Layer

职责：

- 统一 CLI 执行
- 统一日志与验证
- 避免“工具执行成功，但模型没补最后一句就整轮失败”

### 4.5 Agent Policy Layer

职责：

- 修正模型的决策顺序

新规则：

1. 已知命令名时，优先 `inspect`
2. 命令名不确定时，使用 `discover(query=...)`
3. `detect` 只做概览，不用于判断是否安装
4. `bash` 不再做 PATH/CLI 可用性诊断

### 4.6 UI Layer

职责：

- 把 CLI 诊断语义显式展示给用户

必须显示：

- Working Directory
- Resolved Executable Path
- Source Environment
- Effective PATH
- 为什么没识别到
- 建议动作

## 5. 模块改造

### 5.1 Host Rust 模块

#### `desktop/src-tauri/src/cli_runtime/detector.rs`

新增：

- `discover_all_commands(env: &BTreeMap<String, String>, query: Option<&str>, limit: usize) -> Vec<String>`
- `is_executable_file(path: &Path) -> bool`
- `is_command_in_default_detect_catalog(command: &str) -> bool`

实现方式：

1. 读取 `PATH`
2. 逐目录列举文件名
3. 筛掉不可执行项
4. 按文件名去重
5. 按 query 过滤
6. 按 limit 截断

约束：

- `discover` 不做 `--version`
- `discover` 只做文件层发现
- `inspect` 才负责版本探测

#### `desktop/src-tauri/src/cli_runtime/path_env.rs`

扩展：

- 把 `effective_path_entries` 作为可返回数据
- 增补更多常见运行时目录：
  - `~/.nvm/versions/node/*/bin`
  - `~/.volta/bin`
  - `~/.fnm/*`
  - `~/.asdf/shims`

约束：

- 不全盘扫描 home
- 对这些目录走 targeted scan

#### `desktop/src-tauri/src/cli_runtime/runtime_resolver.rs`

扩展：

- `resolved_from`
- `resolved_via_environment_id`
- host path 与 managed env path 的优先级说明

#### `desktop/src-tauri/src/commands/cli_runtime.rs`

新增 channel：

- `cli-runtime:discover`

建议输入：

```json
{
  "query": "lark",
  "limit": 50
}
```

建议输出：

```json
{
  "success": true,
  "commands": ["lark-cli", "lark", "node", "npm"],
  "pathHash": "...",
  "searchedPathEntriesCount": 18
}
```

扩展 `inspect` 输出：

```json
{
  "id": "cli-tool-lark-cli",
  "name": "lark-cli",
  "resolvedPath": "/Users/Jam/.nvm/versions/node/v20.20.0/bin/lark-cli",
  "resolvedFrom": "host-shell-path",
  "effectivePathPreview": [
    "/Users/Jam/.nvm/versions/node/v20.20.0/bin",
    "/opt/homebrew/bin"
  ],
  "isInDefaultDetectCatalog": false,
  "versionProbeSucceeded": true
}
```

#### `desktop/src-tauri/src/tools/app_cli.rs`

扩展兼容映射：

- `environment.create`
  - `name -> scope`
  - `npm-global -> app-global`
- `install`
  - `installSpec -> spec`
  - `name -> toolName`
  - `environmentId` 变 optional
- `inspect`
  - 支持 `command`
  - 支持 `executable`
  - 支持 `toolId`

要求：

- 所有兼容翻译写入 `__compat`
- 便于日志和排错

#### `desktop/src-tauri/src/tools/catalog.rs`

调整 schema：

- `cli_runtime.install.environmentId` 从 required 改成 optional
- 新增 `cli_runtime.discover` schema

### 5.2 Renderer / React

#### `desktop/src/pages/Settings.tsx`

新增面板入口：

- CLI Diagnostics
- Discovered Tools

#### `desktop/src/pages/settings/SettingsSections.tsx`

新增 UI 区块：

1. Diagnostics Form
   - 输入 command
   - Diagnose 按钮

2. Diagnostics Result
   - `resolvedPath`
   - `resolvedFrom`
   - `effectivePathPreview`
   - `isInDefaultDetectCatalog`
   - `versionProbeSucceeded`
   - `cwd`
   - `environment`

3. Discover Results
   - 搜索 query
   - 列出 PATH 中命中的 command

要求：

- stale-while-revalidate
- 保留上一轮成功结果
- 刷新失败不清空面板

### 5.3 AI / Runtime 层

改动位置：

- runtime system prompt 资产
- skill prompt guidance
- tool choice 路由策略

新规则：

1. 已知命令名：
   - `inspect(command="lark-cli")`
2. 命令名模糊：
   - `discover(query="lark")`
3. `detect` 只能回答：
   - 常用工具里哪些 ready
4. agent 禁止再把：
   - `detect` miss
   - 解释成“系统没安装”

## 6. AI、视频、UI 的实现方式

### 6.1 AI

实现原则：

- LLM 不再推断 PATH
- LLM 不再回退 `bash which`
- 宿主返回 typed diagnosis
- LLM 只负责基于结构化结果决策下一步

标准路由：

1. 命令名已知：
   - `inspect`
2. 命令名不确定：
   - `discover`
3. truly missing：
   - `install`
4. 已解析成功：
   - `execute`

### 6.2 视频处理

视频模块必须复用这套底座。

目标工具：

- `ffmpeg`
- `ffprobe`
- `remotion`
- `yt-dlp`

原则：

- 视频导出前先 `inspect`
- 缺失再 `install`
- 执行统一走 `cli_runtime.execute`
- 输出验证统一走 `verify`

### 6.3 UI

UI 不是只展示 “success / failed”。

而是明确展示：

- 找到了什么
- 从哪找到的
- 没找到是因为：
  - PATH 里没有
  - 不在默认 detect 列表
  - 命令名不对
  - 仅存在于受管环境

## 7. 必须用现成库 vs 必须自研

### 7.1 必须用现成库

- Rust 标准库：目录遍历、文件判断、进程调用
- `serde` / `serde_json`
- 现有 process / runtime helpers
- 现有 CLI Runtime 持久化与 event 基础设施

### 7.2 必须自研

- `discover_all_commands`
- `resolvedFrom` 语义
- detect / discover / inspect 的产品语义区分
- agent routing contract
- CLI Diagnostics UI
- tool-only final fallback summary contract

## 8. 性能策略

1. `discover` 结果按 PATH hash 缓存
2. 默认只返回前 100 个命令
3. `discover` 只看文件名，不做 `--version`
4. `inspect` 才做版本探测
5. targeted scan：
   - `nvm`
   - `volta`
   - `fnm`
   - `asdf`
6. UI 使用 stale-while-revalidate
7. `effectivePathPreview` 只返回前若干项，不把整条 PATH 全量灌进 UI

## 9. 产品规则

升级后必须明确 3 条规则：

1. **没在 `detect` 里看到，不等于没安装**
2. **CLI 可见性由 `inspect/discover` 决定，不由 `bash` 决定**
3. **工作目录只影响执行，不决定命令能否被解析**

## 10. 验收标准

### 10.1 CLI 发现

- `lark-cli` 安装在 `~/.nvm/.../bin` 中时：
  - `inspect("lark-cli")` 返回真实路径
  - `resolvedFrom = host-shell-path`

- `detect` 未列出 `lark-cli` 时：
  - agent 不再误判为未安装
  - agent 会改走 `inspect` 或 `discover`

### 10.2 运行时行为

- agent 不再回退到 `bash` 执行：
  - `which`
  - `command -v`
  - `echo $PATH`

- CLI 工具执行成功但模型无最终文本时：
  - 不再出现 `interactive runtime returned an empty final response`
  - 系统会用最近工具结果做兜底说明

### 10.3 UI

- Settings 中可以手动输入 `lark-cli`
- 点击 Diagnose 后能看到：
  - `resolvedPath`
  - `resolvedFrom`
  - `effectivePathPreview`
  - `isInDefaultDetectCatalog`

### 10.4 视频链路

- `ffmpeg` / `ffprobe` 与普通 CLI 共用同一解析和诊断模型

## 11. 原子提交计划

严格按 Atomic Commits 执行：

1. `feat(cli-runtime): add path discovery API`
2. `feat(cli-runtime): expose resolve diagnostics metadata`
3. `refactor(agent): prefer inspect and discover over detect`
4. `feat(settings): add cli diagnostics panel`
5. `refactor(video): align ffmpeg resolution with cli runtime`
6. `fix(runtime): remove bash fallback for cli availability diagnosis`
7. `docs(cli-runtime): document detect vs discover vs inspect`

## 12. 推荐结论

最优解不是给 `lark-cli` 做特判，也不是继续扩默认探测名单。

最优解是把 RedBox 的 CLI Runtime 升级成：

- `detect`：概览
- `discover`：全 PATH 搜索
- `inspect`：精确解析

再把 agent 的决策固定成：

- 已知命令先 `inspect`
- 模糊命令再 `discover`
- 永不再用 `bash` 诊断 PATH

这套升级做完后，`lark-cli` 只是第一个受益者，后续所有 npm / cargo / go / ffmpeg / remotion / 长尾本机 CLI 都会一起变稳。
