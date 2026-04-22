# Runtime Script Execution V1

Phase 5 为 `RedBox` 增加了受限程序化执行层，用于把机械多步读取和整理压缩成一次脚本执行。

## 为什么采用内置脚本而不是外部 Python / Node

对比过三条方案：

- 外部 Python：实现快，但桌面端无法保证目标机器有 Python，发布时最脆弱。
- 外部 Node：仓库开发环境有 Node，但最终桌面运行时同样不能假设用户本机存在 Node。
- 内置 `redbox_script_v1`：不依赖外部解释器，能直接走宿主 capability、workspace 边界和 checkpoint 体系。

当前已经落地的是第三种，也是这个仓库里最稳的方案。

## 入口

- IPC: `runtime:execute-script`
- Tool action: `redbox_runtime_control(action=runtime_execute_script)`

## 可用 runtime mode

- `knowledge`
- `diagnostics`
- `video-editor`

其他 mode 默认不可用，尤其不会在 publish / redclaw automation 中直接打开。

## 脚本格式

脚本版本固定为 `redbox_script_v1`。

```json
{
  "version": "redbox_script_v1",
  "steps": [
    {
      "op": "tool",
      "tool": "app.query",
      "input": {
        "operation": "knowledge.search",
        "query": "agent"
      },
      "saveAs": "search"
    },
    {
      "op": "for_each",
      "items": "search.results",
      "itemAs": "hit",
      "maxItems": 2,
      "steps": [
        {
          "op": "tool",
          "tool": "fs.read",
          "input": {
            "path": "{{hit.path}}"
          },
          "saveAs": "doc"
        },
        {
          "op": "stdout_write",
          "text": "## {{hit.title}}\n{{doc.content}}\n"
        }
      ]
    },
    {
      "op": "artifact_write",
      "path": "knowledge/report.md",
      "content": "{{stdout}}"
    }
  ]
}
```

## 可用工具桥

- `app.query`
- `fs.list`
- `fs.read`
- `memory.recall`
- `editor.script_read`
- `editor.project_read`
- `editor.remotion_read`
- `mcp.list_servers`
- `mcp.list_tools`
- `mcp.list_resources`
- `mcp.list_resource_templates`

## 预算与限制

每次执行都会带上 host 预算：

- `timeoutMs`
- `maxStdoutChars`
- `maxToolCalls`
- `maxArtifacts`
- `maxArtifactChars`
- `maxSteps`
- `maxLoopItems`
- `maxFsReadChars`
- `maxFsListEntries`
- `maxRecallChars`
- `maxRecallHits`

脚本只能把 artifact 写到宿主创建的临时工作目录；不开放任意磁盘写入。

## 输出模型

最终结果固定是：

- `stdout`
- `artifactPaths`
- `toolCallCount`
- `stepCount`
- `errorSummary`
- `estimatedPromptReductionChars`

中间工具结果只保留在脚本执行器内部，不会直接回灌到最终对话上下文。

## 持久化与诊断

如果脚本绑定了 session：

- 会写 `runtime.script_execution` checkpoint

如果脚本绑定了 runtime task：

- 会写 `scripted_execution` task trace
- 会把 artifact path 挂到 task artifact

宿主 `debug:get-runtime-summary` 也会显示：

- script runtime 是否启用
- 允许的 mode
- 执行次数
- 最近执行结果与 prompt reduction
