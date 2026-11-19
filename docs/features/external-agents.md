# 接入外部 Agent 与素材库模式

## 定位

Beav 不只自己用 AI，也可以当作其他 AI 工具的「创作者数据层」：Claude Code、Codex、WorkBuddy、Claude 桌面版、Cursor 等通过本机 MCP 读取你的账号档案、参考库、素材库和稿件，使用 Beav 的社媒采集、生图等工具，或把任务派给 Beav 自己的 Agent。配合素材库模式，可以只把 Beav 当带 AI 理解的素材库，用自己常用的 Agent 创作。

## 接入 Agent

- 入口：账号菜单或素材库模式侧栏左下角的「接入 Agent」，右侧数字是已连上的 Agent 数量。
- Codex 和 WorkBuddy 可以一键写入 MCP 配置，也可以在同一页复制安装指引，安装含 Beav Creator Skill 的插件。安装后在 Codex 新任务或重新加载插件的 WorkBuddy 对话中调用 `creator_status`、`workspace_list` 和 `creator_tools`。
- 支持 `extension prepare deepseek` 的桌面版增加 DeepSeek Harness 分页。在目标 Harness 的 Plugins → Add plugin 中选择准备命令返回的本地 `bundlePath`，加载后即可使用以 `mcp__beav__` 开头的工具。Claude Code、Claude 桌面版、Cursor 和「其他」保留各自的配置步骤。
- 状态：「已连接」（本次启动后调用过）或「已授权，等待第一次调用」。
- 外部 Agent 和 Beav 共享记忆和创作偏好；它写好的稿件、打包的素材可以回写到 Beav 的我的作品和素材库。
- 两条通道：Agent 通过 MCP 直接操作数据和工具；你通过本机网页查看、审批和编辑。外部 Agent 不靠点网页或看截图判断任务完成。

## 本机素材库网页

`http://127.0.0.1:31937/library`：在浏览器或 AI 工具的侧栏里打开，访达风格。

- 左栏和 App 一致：素材库（全部素材、分类、生成记录）、已导入，分隔线下是我的作品、参考库。
- 当前空间可整理、上传、移到废纸篓、编辑提示词和稿件；按空间 ID 打开的其他空间只读。
- 卡片可复制短链接或「加到对话」，把内容交给正在用的 AI；Agent 发来的链接也能直接打开。
- 有本机只读接口供程序读取。
- 需要 Beav 在运行（关闭窗口后默认在后台继续运行，端口和 MCP 照常可用）。

## 素材库模式

- 切换：设置 → 常规 → 使用模式 →「素材库模式」，确认后切换；或 ⌘⇧M / Ctrl+Shift+M。全 App 生效，不跟空间走。
- 收起左侧主侧栏、对话和 AI 创作，只剩素材库自己的侧栏：顶部「热点」「日历」，下面是素材库、已导入、我的作品、参考库；底部是「环境变量」和「接入 Agent」。
- 素材入库后的 AI 处理（拆解、转写、视觉索引）和定时任务照常运行，照常扣积分。
- 热点的「AI 讨论」换成「存为选题」。打开对话等 Agent 模式页面时，顶部提示可一键切回 Agent 模式。

## 相关

- 外部 Agent 能用的密钥：[工具&技能](tools-and-skills.md)的环境与密钥。
- 在浏览器里用完整的 Beav（不只是素材库）：[网页访问与服务器版](remote-access.md)。
