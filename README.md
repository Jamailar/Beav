<p align="center">
  <img src="./images/beav-agent-workflow-hero.png" alt="Beav（原RedBox）" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Jamailar/RedBox?style=flat-square&color=E11D48" alt="Version">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT--NC-E11D48?style=flat-square" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-6C757D?style=flat-square" alt="Platform">
</p>

---

<p align="center">
  <strong>面向通用 AI Agent 的自媒体素材库与创作工具</strong><br>
  <em>Codex / Hermes / OpenClaw 接入 | 素材采集 | 多模态资产管理 | 稿件与封面 | 视频处理</em>
</p>

<p align="center">
  <a href="https://redbox.ziz.hk/download">
    <img src="https://img.shields.io/badge/⬇️%20立即下载-最新版本-E11D48?style=for-the-badge&logo=github&logoColor=white" alt="Download" height="46">
  </a>
</p>

<p align="center">
  <strong>教程：</strong>
  <a href="https://www.bilibili.com/video/BV1V3onBdEf9/?share_source=copy_web&vd_source=54733b01cc63209b4e5b5254537d4bab">Bilibili 视频教程</a>
  ·
  <a href="https://www.youtube.com/watch?v=9Glgg3naHbg">YouTube 视频教程</a>
</p>

<p align="center">
  <a href="./readme_en.md">English</a> | <strong>简体中文</strong> | <a href="./readme_tw.md">繁體中文</a> | <a href="./readme_jp.md">日本語</a> | <a href="./readme_ko.md">한국어</a> | <a href="./readme_es.md">Español</a> | <a href="./readme_pt.md">Português</a> | <a href="./readme_tr.md">Türkçe</a>
</p>

---

## Star History

<a href="https://www.star-history.com/?repos=Jamailar%2FRedBox&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=Jamailar/RedBox&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=Jamailar/RedBox&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=Jamailar/RedBox&type=date&legend=top-left" />
 </picture>
</a>
## 📋 快速导航

<p align="center">

[项目概览](#项目概览) ·
[核心功能](#核心功能) ·
[推荐工作流程](#推荐工作流程) ·
[Agent 接入](#agent-接入) ·
[功能截图](#功能截图) ·
[插件采集](#插件采集) ·
[快速开始](#快速开始) ·
[社区](#社区)

</p>

---

## 项目概览

> **品牌更名说明**：从 **2.5.0** 开始，RedBox 正式更名为 **Beav（原RedBox）**。历史文档、旧版本下载包、仓库路径和部分协议名称中仍可能保留 RedBox / RedConvert 命名；它们指向的是同一款产品的不同阶段。

**Beav（原RedBox）** 是一个面向 Codex、Hermes、OpenClaw 等通用 AI Agent 用户的本地自媒体素材库与创作工具。它不试图替代你正在使用的 Agent，而是为这些 Agent 提供可采集、可检索、可引用、可生成、可剪辑、可导出的创作资产底座。

你可以把小红书、YouTube、网页、公众号、图片、视频、评论区和本地文档沉淀到 Beav（原RedBox），再让通用 Agent 通过本地工具接口检索素材、组织选题、写稿、生成封面、处理视频、导出项目包。内置 Chat / RedClaw 仍然可用，但新的核心定位是：**让任何通用 Agent 拥有一个面向自媒体创作的本地资产工作区**。

## 核心功能

### 给通用 Agent 使用的自媒体素材与创作底座

围绕内容生产，把素材采集、资产管理、语义检索、项目组织、稿件、封面、视频处理和自动化执行放进同一条可被 Agent 调用的工作流。

![评论区洞察](https://github.com/Jamailar/RedBox/releases/download/v2.3.0/redbox-2.3.0-comment-insights.png)

1. **Agent 接入层**：面向 Codex、Hermes、OpenClaw 等通用 Agent 提供本地 MCP / CLI / API 接入方向，让外部 Agent 可以检索素材、读取资产、写入项目、提交生成任务和导出结果。
2. **浏览器素材采集**：浏览器插件支持保存小红书笔记、评论区、YouTube 视频、公众号文章、网页链接、选中文字和网页图片，外部内容可以直接进入本地素材库。
3. **多模态素材库**：统一管理文本、图片、视频、音频、评论、截图、AI 生成结果、导入素材和稿件关联资产，并保留来源、标签、缩略图、文件引用和项目绑定关系。
4. **知识库与语义检索**：把采集内容、本地文档、视频转写、网页正文和图片信息沉淀为可搜索上下文，供 Agent 在写稿、选题、复盘和生成时引用。
5. **选题中心与创作 brief**：从评论、网页、历史素材和用户输入中整理内容机会，把洞察转成结构化 brief，继续进入脚本、图文、封面和视频项目。
6. **稿件与项目包**：支持图文稿、视频稿、音频稿、Remotion 场景、字幕、素材绑定和导出，让 Agent 的创作结果变成可编辑、可复用的内容项目。
7. **媒体生成与视频处理**：支持图片、视频、音频等媒体生成，提供参考图、任务队列、成本预估、生成历史和结果回流，适合作为 Agent 的媒体处理运行时。
8. **封面与平台视觉资产**：围绕标题、正文、参考图和平台目标生成封面图，沉淀模板、底图、标题组和历史封面资产。
9. **主体库**：统一管理人物、商品、场景、品牌 IP、角色声音和参考素材，帮助系列内容在写稿、生图、封面和视频里保持一致性。
10. **内置自动化入口**：RedClaw、Chat、Team 和后台 Runner 继续作为内置 Agent 入口，可处理长周期任务、定时任务、技能调用和自动化执行。

## 推荐工作流程

Beav（原RedBox）最适合被当成 Agent 友好的自媒体生产工作区：用户负责建立主题和边界，Beav（原RedBox）负责沉淀素材、组织上下文和执行媒体任务，外部 Agent 负责规划、判断和连续创作。推荐流程如下：

1. **建立工作空间**：按账号、赛道、客户或项目创建工作空间，例如 `护理考研账号`、`AI 工具测评`、`跨境商品短视频`。把工作空间当成 Agent 后续读取素材、写稿和做图的默认上下文。
2. **采集素材入库**：安装浏览器插件后，把小红书笔记、评论区、YouTube 视频、公众号文章、网页、图片和本地文件保存到对应工作空间。采集时尽量保留来源、标签和分类，让 Agent 后续能知道素材来自哪里、为什么重要。
3. **沉淀知识与资产**：把采集内容进入知识库、媒体库和主体库。文本素材用于检索和引用，图片/视频/音频用于参考和复用，人物、商品、品牌、场景等稳定对象进入主体库，避免每次创作都从零描述。
4. **自动选题与 brief**：让 Agent 基于素材、评论区、高赞内容、搜索结果和历史稿件生成选题 brief。一个合格 brief 应包含目标受众、痛点、观点、标题方向、素材引用、内容结构、平台风格和禁忌。
5. **自动创作稿件**：在稿件工作台或外部 Agent 中调用 Beav（原RedBox）的素材上下文，生成图文稿、视频脚本、口播稿或多版本标题。稿件不要只是一段正文，应保留引用素材、封面需求、分镜/段落结构和待生成媒体清单。
6. **自动做图与媒体生成**：进入自由创作、封面或媒体库，基于稿件、参考图、主体库和 brief 生成封面图、配图、视频片段或音频。生成结果回流到媒体库，继续作为下一轮 Agent 创作的可检索资产。
7. **复盘与复用**：把最终稿件、封面、发布反馈、评论区和数据复盘继续保存回 Beav（原RedBox）。下一次选题时，Agent 可以直接比较历史表现、复用高转化结构，并围绕同一主体持续生产系列内容。

这条流程对 Agent 友好的关键是：**不要只把任务写在聊天里，而是把素材、brief、稿件、图片、视频和反馈都保存成 Beav（原RedBox）里的结构化资产**。Agent 每次接手时可以先读取工作空间，再决定要采集、检索、写稿、做图还是导出。

## Agent 接入

Beav（原RedBox）的长期方向是成为通用 Agent 的本地自媒体创作资源层。外部 Agent 负责规划和推理，Beav（原RedBox）负责提供素材、上下文、媒体处理和创作产物管理。

当前优先接入方式是本地 **ACP Agent Gateway**：外部 Agent 先通过本机 discovery 文件或 helper 发现当前端口，再读取 Beav（原RedBox）Creator Agent 的 manifest / guide，创建或复用 ACP 会话，把创作任务交给 Beav（原RedBox）AI，并通过事件轮询拿到状态和素材/稿件产物引用。详细方案见 [`desktop/docs/redbox-acp-agent-gateway-implementation-plan.md`](desktop/docs/redbox-acp-agent-gateway-implementation-plan.md)，使用说明见 [`desktop/docs/redbox-acp-agent-gateway-usage.md`](desktop/docs/redbox-acp-agent-gateway-usage.md)，命令行 helper 见 [`desktop/scripts/redbox-acp-client.mjs`](desktop/scripts/redbox-acp-client.mjs)。

外部 Agent 的推荐发现顺序是：读取 `REDBOX_ACP_DISCOVERY_FILE` 或系统默认的 `RedBox/acp-gateway.json`，再访问其中的 `manifestUrl` / `guideUrl`；如果文件不存在，再回退到默认 `http://127.0.0.1:31937/acp/v1`。这些兼容名称仍会保留，方便 Codex、Hermes、OpenClaw 不依赖用户电脑上的固定端口或品牌目录变更。

| 接入对象 | 使用 Beav（原RedBox）做什么 | 推荐能力形态 |
| --- | --- | --- |
| Codex | 读取本地素材、整理选题、生成稿件、调用媒体处理任务、导出创作包 | ACP Gateway / CLI helper / 后续 MCP |
| Hermes | 把 Beav（原RedBox）作为长期素材库和创作上下文来源，结合记忆、技能和自动化流程执行内容任务 | ACP Gateway / workspace context |
| OpenClaw | 通过本地素材、项目包和浏览器采集结果执行自媒体生产流程 | ACP Gateway / CLI helper |
| 其他 AI Agent | 检索素材、读取文件、保存生成结果、复用封面模板和媒体任务 | ACP Gateway / 标准化工具协议 |

推荐的工具边界是：Agent 调用结构化能力，Beav（原RedBox）保存真实素材和产物。不要让 Agent 只拿自然语言描述猜测文件，也不要把媒体生成、视频渲染、素材索引这类重任务塞进一次性聊天上下文里。

## 功能截图

### 评论区洞察
![评论区洞察](https://github.com/Jamailar/RedBox/releases/download/v2.3.0/redbox-2.3.0-comment-insights.png)

### 为笔记生成封面图
![为笔记生成封面图](https://github.com/Jamailar/RedBox/releases/download/v2.3.0/redbox-2.3.0-cover-generation.png)

### 评论区存档功能
![评论区存档功能](https://github.com/Jamailar/RedBox/releases/download/v2.3.0/redbox-2.3.0-comment-archive.png)

### 知识库与素材沉淀
![Knowledge](./images/knowledge.png)

### 选题中心
![Wander](./images/wander.png)

### 稿件工作台
![Manuscripts](./images/manuscripts.png)

### 自由创作（生图 / 生视频）
![Creation Page](./images/creation-page.jpg)

### RedClaw 自动化执行
![RedClaw](./images/redclaw.png)

### 主体库
![Subjects](./images/subjects.png)

### 团队协作
![Team](./images/team.png)

### 媒体库
![Media Library](./images/media-library.png)

### 封面图生成
![Cover Generation](./images/gen_cover.jpg)

## 插件采集

浏览器插件负责把外部内容送进 Beav（原RedBox）。小红书笔记、评论区、YouTube 视频、公众号文章、网页链接、选中文字和网页图片都可以进入本地素材库，作为后续 Agent 检索、选题、分析、写稿、封面和视频创作的上下文。

### 采集小红书笔记与评论区
![Save Xiaohongshu](./images/plugin-save-xiaohongshu.gif)

### 保存 YouTube 视频
![Save YouTube](./images/plugin-save-youtube.gif)

### 保存网页图片
![Save Image](./images/plugin-save-image.gif)

## 快速开始

1. 在 [Beav（原RedBox）下载页](https://redbox.ziz.hk/download) 下载并安装。
2. 选择或创建工作空间，用它存放素材、项目、稿件、媒体和生成结果。
3. 打开 `设置 -> AI`，按需填写 Endpoint / Key / Model，或使用官方 AI 能力。
4. 安装并加载 `Plugin/` 里的 Chrome / Edge 扩展，把网页、图片、视频和评论区保存进素材库。
5. 从 `素材采集 -> 知识库 / 媒体库 -> 选题 brief -> 稿件 / 封面 / 视频 -> 导出` 跑通一次内容生产流程。
6. 在 Codex、Hermes、OpenClaw 等通用 Agent 中接入 Beav（原RedBox）的本地工具能力，让外部 Agent 直接使用这些素材和创作工具。

## 社区

<a href="./images/wechat.png"><img src="./images/wechat.png" alt="加入微信交流群" width="280"></a>

- [GitHub Issues](https://github.com/Jamailar/RedBox/issues)
- [GitHub Discussions](https://github.com/Jamailar/RedBox/discussions)

## 更新日志

### v2.5.0

Beav（原RedBox）2.5.0 的重点是 **ACP Agent Gateway**：Codex、Claude Code、Hermes、WorkBuddy、OpenClaw 等外部 Agent 可以直接与 Beav 沟通，发现本机 Beav 服务、读取 Creator Agent manifest / guide、创建或复用会话、提交创作任务，并通过事件轮询拿到执行状态和素材/稿件产物引用。

Beav 负责保存真实素材、知识库上下文、媒体资产、稿件、封面和生成任务；外部 Agent 负责规划、推理、拆任务和调用能力。这样 Agent 不需要靠复制粘贴素材，也不需要把图片、视频、素材索引等重任务塞进一次聊天上下文。

从 2.5.0 开始，RedBox 正式更名为 **Beav（原RedBox）**。Beav（原RedBox）延续原 RedBox / RedConvert 的本地素材库、Agent 接入、媒体资产管理、稿件与封面、视频处理和自动化能力；旧名称仍会在历史版本、文档链接、仓库路径或兼容协议中保留一段时间。

### v2.4.0 (2026-06-20)

Beav（原RedBox）2.4.0 正式版把浏览器能力从“读网页内容”升级到“操作你正在使用的真实 Chrome”。AI 可以在你授权后接管已打开的后台、数据面板或网页工具，读取页面内容、点击筛选、输入搜索、滚动和截图，用来完成需要登录态和真实页面交互的任务。这一版也补上了 Task Brief、工具层瘦身和对话过程显示优化，长任务不再只靠聊天记录硬撑。

#### 你现在可以用它做什么

- 查看已登录后台的数据，例如 Umami、管理后台、运营面板，让 AI 直接读取当前页面里的表格和指标。
- 操作网页工具，例如打开 Google Trends、切换地区或时间范围、搜索关键词并整理结果。
- 在复杂网页里完成重复操作，例如点击按钮、填写输入框、滚动加载内容、截取页面证据。
- 让 AI 区分网页搜索结果和真实浏览器页面，不再把普通网页读取误当成浏览器操作。

#### Task Brief：让长任务有工作底稿

- 长任务可以使用 Task Brief 保存目标、待办、关键事实、阶段结论、决策和验证要求，后续对话可以接着这个工作底稿继续。
- 选题、调研、写作和运营任务可以把读者问题、内容打法、候选标题、引用事实和避坑要求写进 brief，减少上下文变长后丢重点。
- Task Brief 也能记录目标状态和上下文余量估算，更适合跟踪多轮任务是否完成、卡住或需要压缩上下文。

#### 更容易看清 AI 正在做什么

- 被 Beav（原RedBox）接管或创建的标签页会显示 `Beav（原RedBox）控制中` 标识，释放后自动消失。
- 对话里的阶段说明、工具调用和结果回放更稳定，长任务过程中更容易看清 AI 正在做什么、做到哪一步。
- 运行日志会更稳定地保留浏览器操作过程和关键工具结果，恢复会话后也能复盘它做过什么。
- 启动桌面端时会恢复上次使用的应用视图，减少回到错误页面的情况。

#### 工具层瘦身

- AI 可见的工具入口更少、更明确，网页搜索、真实浏览器、命令执行、Task Brief、会话资源等能力边界更清楚。
- 低频或兼容性工具被收进兼容层，正常对话里不再暴露一堆相互重叠的工具名，减少 AI 选错工具或重复调用。
- 命令执行能力更接近真实终端，适合让 AI 处理 CLI、构建、诊断和需要持续输入的本机任务。

#### 隐私和安全

- 默认使用用户已经安装插件的真实 Chrome，不再用临时 Chromium 代替真实验收。
- 浏览器历史、剪贴板、浏览器上下文等敏感能力不会被静默读取，会进入更高风险授权路径。
- 浏览器控制不需要读取 macOS Keychain / Chrome Safe Storage；如果系统弹出这类敏感授权，应该拒绝。

#### 下载

v2.4.0 已发布为正式版，提供 macOS、Windows 多架构安装包和浏览器插件包：

- [查看 v2.4.0 Release](https://github.com/Jamailar/RedBox/releases/tag/v2.4.0)
- macOS：`RedBox_2.4.0_aarch64.dmg`、`RedBox_2.4.0_x64.dmg`
- Windows：`RedBox_2.4.0_x64-setup.exe`、`RedBox_2.4.0_arm64-setup.exe`、`RedBox_2.4.0_x86-setup.exe`
- 浏览器插件：`RedBox_Browser_Extension_2.4.0.zip`

### v2.3.0 (2026-06-17)

Beav（原RedBox）2.3.0 重点增强小红书评论区采集与选题洞察能力。浏览器插件现在可以采集笔记评论区内容，并把评论沉淀到知识库中，后续可直接交给 AI 分析用户关注点、高频问题、购买顾虑和潜在内容选题。

#### 小红书评论区采集与选题洞察

- 浏览器插件支持采集小红书笔记评论区内容，并将评论保存到 Beav（原RedBox）知识库。
- 评论区内容可以进入 AI 分析流程，帮助洞察用户真实需求、情绪反馈、高频问题和选题机会。
- 选题中心支持基于评论区内容生成创作 brief，把用户讨论转化为内容选题、脚本方向和后续创作任务。
- 优化小红书评论加载与采集稳定性，提升长评论区、分页评论和中断恢复场景下的可靠性。

#### AI 与创作能力升级

- 升级官方 OpenAI 调用链路，支持 Responses API、结构化上下文片段和 provider 级网页搜索能力。
- 增强 Agent 网页搜索工具调用，搜索结果来源可以更稳定地进入最终回答。
- 自由创作支持拖拽添加媒体参考图，图片编辑请求诊断更清楚，生成任务的媒体结果回流更稳定。
- 生成工作台新增积分成本预估，提交前可以看到图片、视频等生成任务的大致消耗。

#### 会员、插件与会话管理

- 新增创始赞助会员入口和会员权益基础能力，优化官方账号、支付和权益同步链路。
- 新增 Codex 插件市场基础能力，插件采集链路支持 checkpoint，长内容采集中断后更容易恢复。
- 新增会话导入导出和会话列表右键菜单，历史会话管理更方便。
- 优化选题中心和工作区入口，减少冗余入口，让选题、素材和创作路径更集中。

#### 修复与稳定性

- 修复 Windows 知识库文件导入路径诊断问题，路径过长、文件名异常或源文件缺失时更容易定位原因。
- 修复生成工作台 Agent 媒体结果流、已完成占位项残留和生成 feed 初始化抖动问题。
- 修复通知同步未正确触发官方账号认证刷新的问题，登录过期时能更稳定地进入重新登录流程。
- 修复团队协作唤醒循环、团队 guide 创建路由、知识库健康统计、网页搜索透传和默认工作区显示等问题。

#### 下载

v2.3.0 当前为预发布版本，已提供 macOS、Windows 多架构安装包和浏览器插件包：

- [查看 v2.3.0 Release](https://github.com/Jamailar/RedBox/releases/tag/v2.3.0)
- macOS：`RedBox_2.3.0_aarch64.dmg`、`RedBox_2.3.0_x64.dmg`
- Windows：`RedBox_2.3.0_x64-setup.exe`、`RedBox_2.3.0_arm64-setup.exe`、`RedBox_2.3.0_x86-setup.exe`
- 浏览器插件：`RedBox_Browser_Extension_2.3.0.zip`

### v2.2.1 (2026-05-30)

Beav（原RedBox）2.2.1 重点修复浏览器插件文章采集入库，尤其是微信公众号文章。长文、多图公众号文章现在可以更稳定地保存到 app，知识库也能正确按链接文章、公众号文章、知乎回答和知乎文章分类展示。

#### 插件采集与知识库

- 修复微信公众号文章保存链路，避免多图文章因为请求体过大保存失败。
- 公众号文章保留富文本阅读快照，正文图片继续进入知识库素材，方便后续复用。
- 修复链接文章和公众号文章在知识库里的分类映射，保存后可以稳定在对应分类中看到。
- 确认通用网页链接、微信公众号文章、知乎回答、知乎专栏文章都使用 app 端正式 Knowledge API 类型入库。

#### 工作台与稳定性

- 自由创作改为默认工作区视图，进入 app 后更快回到核心创作任务。
- 拆分媒体生成任务队列，减少不同创作入口之间的状态互相影响。
- 强化媒体任务超时处理、团队成员唤醒和官方微信登录 session 同步。
- 补齐 TTS 模型能力识别，减少模型和音色选择不一致导致的失败。

#### 下载

v2.2.1 已发布为正式版，提供 macOS 与 Windows 安装包：

- [查看 v2.2.1 Release](https://github.com/Jamailar/RedBox/releases/tag/v2.2.1)
- macOS：`RedBox_2.2.1_aarch64.dmg`、`RedBox_2.2.1_x64.dmg`
- Windows：`RedBox_2.2.1_x64-setup.exe`
- 浏览器插件：`RedBox_Browser_Extension_2.2.1.zip`

### v2.2.0 (2026-05-22)

Beav（原RedBox）2.2.0 重点增强面向东南亚、欧洲和跨境电商平台的多国家、多语言商品详情页创作。现在可以围绕品牌、商品、平台版本和目标语言组织素材，由 AI Agent 生成适合不同市场的详情页图片，并把生成结果继续沉淀到商品素材工作区复用。

#### 商品详情页创作

- 新增品牌商品素材工作区，支持按品牌、商品、平台和详情页版本管理图片素材。
- 商品详情页支持通过 AI Agent 生成，围绕当前商品资料、平台定位和版本要求自动产出详情页图片。
- 平台版本会自动带入目标市场和语言要求，更适合东南亚、欧洲及跨境电商多国家铺货场景。
- 支持从媒体库和生成结果中回收图片素材，生成后的图片可以直接进入商品详情页工作区继续编辑和复用。

![Beav（原RedBox）2.2.0 多语言商品详情页创作](https://github.com/Jamailar/RedBox/releases/download/v2.2.0/redbox-2.2.0-multilingual-product-detail-pages.gif)

#### 支持的电商平台

淘宝 / 天猫、京东 JD、拼多多 Pinduoduo、抖音电商 / 抖店、快手小店、1688、小红书店铺、唯品会、Alibaba.com、Shopee、Lazada、TikTok Shop、Tokopedia、Bukalapak、Blibli、Tiki、Sendo、ZALORA、Amazon EU/UK、eBay、Etsy、Zalando、ABOUT YOU、Allegro、bol.com、Cdiscount / Octopia、OTTO Market、Kaufland Global Marketplace、eMAG、ManoMano、Temu、SHEIN Marketplace、AliExpress、Trendyol、Kaspi.kz、Ozon、Wildberries、Uzum Market、Satu.kz。

#### 支持的详情页语言

英语、德语、法语、西班牙语、马来语、泰语、繁体中文、印尼语、越南语、葡萄牙语、意大利语、日语、阿拉伯语、荷兰语、波兰语、瑞典语、丹麦语、芬兰语、挪威语、捷克语、斯洛伐克语、斯洛文尼亚语、克罗地亚语、匈牙利语、罗马尼亚语、爱沙尼亚语、拉脱维亚语、立陶宛语、保加利亚语、土耳其语、俄语、韩语、阿塞拜疆语、哈萨克语、亚美尼亚语、吉尔吉斯语、乌兹别克语、格鲁吉亚语、塔吉克语。

#### 生成工作台与稳定性

- 生成工作台拆分出更稳定的请求校验、提交 payload、Agent 上下文和数字人音频解析模块。
- Agent 模式会带上更明确的当前请求、最近资产、可用音色和模糊引用策略，减少“上一张图”“刚才的音频”等上下文丢失。
- 媒体任务支持归档删除，生成历史补齐 `video_sequence` 等任务类型识别，视频序列类结果可以更稳定地回到生成工作台。
- 视频生成时长范围扩展到 1-15 秒，短片段和稍长片段都能走统一任务链路。
- 官方 AI 默认模型缺失后会自动补齐，图片、视频、Embedding、转写、TTS、音色克隆等能力不再误用聊天模型兜底。
- VideoRetalk 参考视频预处理拆分为独立模块，数字人流程的音频生成、参考视频准备和视频提交链路进一步收口。

#### 下载

v2.2.0 已发布为正式版，提供 macOS 与 Windows 安装包：

- [查看 v2.2.0 Release](https://github.com/Jamailar/RedBox/releases/tag/v2.2.0)
- macOS：`RedBox_2.2.0_aarch64.dmg`、`RedBox_2.2.0_x64.dmg`
- Windows：`RedBox_2.2.0_x64-setup.exe`、`RedBox_2.2.0_arm64-setup.exe`、`RedBox_2.2.0_x86-setup.exe`

### v2.0.0 (2026-05-14)

Beav（原RedBox）2.0 是一次面向「AI 内容创作工作台」的重大升级。这个版本不再只是单点生成工具，而是把账号定位、角色克隆、角色卡片、素材理解、图文生成、视频生成、剪辑分析、音频克隆和 Agent 连续执行串成一条完整创作链路。

#### 重大更新

- 全新 AI 创作工作流：Agent 现在可以围绕账号、素材、稿件和媒体任务连续工作，自动拆解需求、调用工具、生成结果并汇总交付。
- 视频生成全面升级到 Seedance 2.0：提升画面质感、运动连贯性、短视频生成稳定性和故事板执行能力。

##### AI 视频理解与自动剪辑切片

现在 AI 可以理解视频内容，分析视频的优点、结构节奏、画面亮点和可复用表达，并自动剪辑出适合二次创作、种草复盘和短视频分发的精彩切片。

![Beav（原RedBox）2.0 AI 视频理解与自动剪辑切片](https://github.com/Jamailar/RedBox/releases/download/v2.0.0/redbox-2.0-video-understanding-auto-clips.gif)

##### 自动字幕识别与视频加字幕

支持自动识别视频中的语音内容，生成字幕并直接叠加到视频画面中，让口播、解说、带货和知识类视频更快完成字幕包装。

![Beav（原RedBox）2.0 自动识别字幕并给视频加字幕](https://github.com/Jamailar/RedBox/releases/download/v2.0.0/redbox-2.0-auto-subtitles.gif)

##### 角色克隆与角色音频克隆

支持基于账号定位、人物设定和内容风格生成可复用的角色卡片，让固定账号、虚拟角色和品牌 IP 拥有稳定的人设、语气、表达边界和创作参考。角色还可以沉淀专属声音资产，让系列化视频、口播、旁白和虚拟角色内容保持更统一的声线识别度。

![Beav（原RedBox）2.0 角色克隆与角色卡片预览](https://github.com/Jamailar/RedBox/releases/download/v2.0.0/redbox-2.0-character-clone-workflow.gif)

##### 商品图智能创作

上传一张商品图，即可自动扩展生成商品套图和短视频素材，帮助电商、种草和品牌内容更快完成从单图到成套内容的生产。

![Beav（原RedBox）2.0 商品图自动生成套图与视频](https://github.com/Jamailar/RedBox/releases/download/v2.0.0/redbox-2.0-product-image-to-asset-video.gif)

- 强化图文到视频链路：图片附件、参考素材、封面、分镜和视频任务之间的引用关系更稳定，减少重复上传和上下文丢失。
- 新增封面创作能力：从选题、文案、图片生成到封面产出，进一步补齐小红书、短视频和账号内容生产的关键环节。
- 升级 Agent 工具调用系统：媒体编辑、图片生成、视频生成、模型配置、附件引用等能力现在可以被 AI 更直接、更稳定地调用。
- 优化 RedClaw 创作体验：稿件、对话、知识引用和任务执行的协作链路更清晰，更适合持续写作、改稿和内容策划。

##### 全新桌面 UI

收敛入口层级，降低视觉噪音，让素材、生成、任务、稿件和结果管理更直观。

![Beav（原RedBox）2.0 全新桌面 UI 体验](https://github.com/Jamailar/RedBox/releases/download/v2.0.0/redbox-2.0-ui-refresh-workflow.gif)

- 强化会话与素材持久化：聊天图片缩略图、媒体任务记录、视频生成历史、会话附件引用等数据保留更可靠。

#### 稳定性与体验优化

- 改进视频生成等待、历史记录、缩略图、播放状态和任务结果回填。
- 优化媒体引用解析，减少视频任务找不到图片、封面或上下文素材的问题。
- 改进 Agent 对视频导演、分镜、音频、时长和最终提示词的理解能力。
- 优化模型配置管理，让不同生成场景可以更稳定地使用对应模型。
- 修复语音、图片、视频、附件和兼容层之间的若干调用问题。
- 调整桌面壳层、侧边栏和设置入口，让高频创作路径更轻、更直接。

#### 这是一个大版本

2.0.0 的重点不是增加几个按钮，而是把 Beav（原RedBox）从「AI 生成工具集合」升级为「自媒体创作 Agent 工作台」：它可以克隆角色、生成角色卡片、沉淀角色声音资产、理解素材、生成内容、处理媒体、维护角色一致性，并把多步创作任务尽可能交给 AI 连续完成。
