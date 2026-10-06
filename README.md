[English](./readme_en.md) | 简体中文

# Beav

本地优先的 AI 内容创作工作台：采集资料、整理素材、撰写图文与剪辑视频。

> **源码快照 ≠ 最新正式版**：本仓库提供 Tauri + Rust 2.5.0 源码快照，并分发持续更新的 Beav 正式安装包。最新正式版采用 Tauri + Rust，其功能和源码公开范围与 2.5.0 不同。公开源码按非商业许可提供（source-available），不是标准 MIT 开源；详见 [LICENSE](./LICENSE)。

![Beav 浏览器插件操作演示：保存小红书笔记与评论](./images/plugin-save-xiaohongshu.gif)

[下载正式版](https://beav.pro/download) · [演示视频](https://www.bilibili.com/video/BV12LNn6nEem/) · [使用指南](https://beav.pro/docs) · [最新 Release](https://github.com/Jamailar/Beav/releases/latest)

## 三个核心使用场景

以下场景介绍持续更新的正式版；公开源码范围见下方对照。

- **积累创作资料**：保存网页、小红书笔记和评论，在知识库中检索、引用与复用。
- **持续经营内容账号**：结合参考资料、选题和账号规划，撰写并修改图文稿、脚本与口播稿。
- **制作图片与视频**：复用图片模板，剪辑口播、编辑字幕、补充画面并导出成片。

## 源码与正式版范围

| 项目 | 公开源码快照 | 持续更新的正式版 |
| --- | --- | --- |
| 版本与技术栈 | Tauri + Rust 2.5.0；公开仓库的 `desktop/` | Tauri + Rust；版本以最新 Release 为准 |
| 功能范围 | 以快照中的代码与历史说明为准 | 本文下方的 2.8 功能介绍与当前使用指南 |
| 2.8 新实现 | 不包含下述 2.8 媒体工坊、剪辑、模板、日报等实现与改进，也不包含当前 Tauri MCP 宿主实现 | 随正式安装包提供；受平台、权限和配置影响 |
| 许可 | 自定义非商业源码许可；商业使用需书面授权 | 适用安装版用户协议及所购服务权益；不由源码许可授予使用权 |

公开仓库不提供最新正式版的完整源码，不能用 2.5.0 快照复现 2.8 安装包。浏览器扩展等公开组件可能单独更新，其版本不代表桌面源码也同步更新。

源码目录、依赖安装与本地构建步骤见 [desktop/README.md](./desktop/README.md)。

## 工作流

| 运营动作 | 使用入口 |
| --- | --- |
| **采集与调研**：保存网页、社媒内容和评论，让 AI 检索公开资料 | Chrome / Edge 插件、对话、知识库 |
| **关注与选题**：阅读运营日报，结合热点、订阅和已有资料寻找方向 | 主页“从选题开始”、日报 |
| **维护账号规划**：整理定位、受众、内容方向和更新节奏 | 主页小工具“账号运营规划” |
| **写稿与改稿**：从目标和参考资料形成图文稿、脚本与口播稿 | 对话、稿件 |
| **制作图片**：填写模板变量、上传参考图，生成并复用视觉素材 | 媒体工坊、图片模板、资产库 |
| **剪辑口播**：分析删减、编辑字幕、补充画中画与动画、导出成片 | 媒体工坊“智能剪口播”、视频编辑器 |
| **安排运营任务**：设置计划，查看执行状态并继续处理结果 | 运营日历、对话 |

## 2.8 正式版功能介绍

以下介绍 **Tauri + Rust 正式版**。这里列出的 2.8 实现与改进不包含在公开的 Tauri + Rust 2.5.0 源码快照中；即使旧版有同名入口，也不代表实现和能力相同。可用功能以所安装版本、账号权限、模型配置和操作系统为准。完整版本变化见[更新日志](./CHANGELOG.md)。

### 媒体工坊与智能口播剪辑

导入口播视频后，Beav 结合逐词转录、语义和声音停顿分析冗余片段，辅助处理重说、口头语和接缝。基础剪辑可应用到时间线，随后检查剪辑记录、直接修改字幕，并补充画中画、花字与镜头动效。可选人声降噪支持开关，方便比较处理前后的声音。

视频工程在独立窗口中编辑，提供多轨时间线、画布变换、关键帧、转场、调色、蒙版和音频调整。右侧 AI 助手可结合当前工程继续修改，操作进入撤销历史。导出时可选择目标目录，查看渲染进度和失败原因，也可单独导出 SRT / WebVTT 字幕。

画中画占位表示待补素材；动画方案需要确认制作，不能把方案当作已经完成的画面。查看时间线、播放效果与实际导出文件后，再使用成片。

### 内置动画与独立特效轨道

使用重点大字、人物介绍、一问一答、数字强调、章节标题等口播叠加预设，填写短文案、主题色和时长后加入时间线；也可添加箭头、圈画等图形装饰与推近、呼吸等镜头动效。内置预设可离线使用。

画面特效拥有独立轨道，可以拖动位置、调整生效范围，并指定作用片段。AI 动画助手可按讲述内容安排辅助画面，后续仍可在编辑器中调整。

### 图片创作与可复用模板

在图片创作工作区管理参考图、画幅、生成进度和结果。模板支持可编辑文字变量与指定参考图；也可以上传图片，让 AI 拆解并保存为自己的模板，再用于不同主题的创作。创建模板和提交图片生成是两个独立操作，在线生成取决于账号权限与模型配置。

### 运营日报与账号长期规划

主页日报结合当前账号方向整理新闻、热点和可借鉴内容，附带来源链接，支持按周翻阅、未读标记和来源预览。可以从日报加入选题、继续创作，或直接讨论本期内容。关注清单可手动编辑，后续生成会结合运营规划、已保存的长期兴趣和反馈调整。

“账号运营规划”小工具用于阅读与编辑定位、受众、栏目方向和更新节奏，保留未保存草稿，并在 AI 同时更新时提供对照合并。长期偏好按通用、平台与账号范围使用，让后续任务能延续适用的创作要求。

### 热点

热点页面把适合当前账号的内容与各平台热榜放在一起查看。账号热点会展示匹配账号方向的内容，并标出来源平台和榜单位置；平台热榜按来源分栏呈现，方便横向浏览小红书、知乎、V2EX 等平台的热门话题。遇到值得跟进的内容，可以直接发起 AI 讨论，将热点继续转成选题或创作思路。

<p align="center">
  <img src="./images/hotspots-page.jpg" alt="Beav 热点页面：账号热点与多平台热榜" width="90%">
</p>

### 随手可用的小工具

- **字幕提取器**：提取字幕，在工具中查看结果并继续处理。
- **图片去 AI 元数据**：查看并清理 PNG、JPEG、WebP 的可移除文件元数据，保留原图并输出独立副本；不处理画面中的 Logo 或像素水印。
- **图片转 Live 图**：选择图片与轻微推拉、平移动效，生成配对照片和视频。2.8 正式版的实现面向 macOS 与 Windows，Linux 暂不支持；Windows 实机与手机导入仍待验收，传输时需同时保留配对文件。
- **账号运营规划**：在当前账号空间中持续维护同一份规划。

小工具从主页打开，按需授权；图片工具支持从素材库选择或从电脑导入。

### 边聊边用的工作区

聊天右侧可用标签页打开浏览器、知识库、资产和文件详情，并调整侧栏宽度。把知识或素材拖入输入框即可作为引用或附件继续讨论。页面返回时优先显示当前空间已有内容，再后台刷新；长任务也改进了上下文衔接、工具结果保存和停止处理。

## 自动社媒调研

围绕你的账号定位、选题目标和已有素材，Beav 会自主检索多个社交平台的公开内容，先筛选候选素材，再深读高价值内容。调研结果可直接沉淀到知识库，成为后续选题、写稿和创作时可检索、可复用的依据。

![Beav 自动检索并深读社媒内容](./images/automated-social-research.jpg)

## 跨平台博主订阅

订阅受支持平台的博主或创作者主页，Beav 可每日自动刷新最新内容，并保存到知识库；可用平台与抓取结果取决于当前数据来源和配置。你可以像追踪一个持续更新的素材源一样，随时检索、筛选和复用这些内容，不必反复手动打开各个平台查看更新。

![订阅博主后每日自动同步到知识库](./images/creator-subscription-daily-sync.jpg)

## 精选自媒体技能市场

在精选自媒体技能市场中，按调研与选题、文案风格、脚本优化、图片制作、视频制作等方向搜索和筛选技能；找到合适的能力后一键安装，直接用于你的内容创作工作流。每个技能都清楚标注用途与分类，让 AI 更贴近具体的运营任务。

![精选自媒体技能市场](./images/curated-creator-skills-marketplace.jpg)

## 功能矩阵

以下仅描述正式版，不是公开源码功能清单。主要能力按正式版入口归纳；在线服务、外部平台及部分媒体格式受账号配置和操作系统支持范围影响。

| 采集与知识 | 选题与运营 | 写作与协作 | 图片与小工具 | 视频剪辑 |
| --- | --- | --- | --- | --- |
| 网页、社媒与评论采集 | 首页选题与灵感 | 图文稿、脚本与口播稿 | AI 图片创作 | 智能口播分析与剪辑 |
| 公开社媒调研 | 运营日报与来源预览 | 可编辑稿件 | 文字变量与参考图模板 | 字幕编辑与样式同步 |
| 博主订阅与每日刷新 | 关注清单与反馈 | 账号规划与长期偏好 | 从图片创建模板 | 画中画与口播叠加动画 |
| 本地文件、文件夹、Obsidian | 运营日历与定时任务 | 多标签侧栏与拖入引用 | 图片元数据清理 | 独立特效轨道与关键帧 |
| 检索与来源引用 | 历史日报与执行记录 | 技能市场与子任务协作 | Live Photo（macOS / Windows） | 人声降噪、转场与音频调整 |
| 素材与资产复用 | 从资讯继续创作 | 外部 Agent 接入 | 字幕提取器 | 成片、字幕与便携工程导出 |

## 产品截图

### 知识库

![知识库与素材沉淀](./images/knowledge.png)

### 评论区洞察（2.3.0 历史截图）

![评论区洞察](https://github.com/Jamailar/Beav/releases/download/v2.3.0/redbox-2.3.0-comment-insights.png)

## 正式版快速开始

1. 前往 [下载页](https://beav.pro/download) 安装 Beav。
2. 为一个账号或品牌创建一个工作空间。
3. 在 `设置 → AI` 使用官方 AI，或配置自己的 Endpoint、API Key 和模型。
4. 如需网页采集，从 [最新 Release](https://github.com/Jamailar/Beav/releases/latest) 获取 Chrome / Edge 扩展。
5. 从主页选题或日报开始创作；已有视频可进入媒体工坊进行剪辑，图片处理和账号规划从主页小工具打开。

不确定某个功能怎么用时，可在对话中让 Beav 查询内置使用指南，再按当前版本的入口操作。

## 信任与边界

- **本地优先**：素材、稿件和项目以本地工作空间为核心组织。
- **模型可选**：支持官方 AI 和 OpenAI-compatible 模型服务。
- **发布透明**：安装包、扩展、更新资产和签名均通过 GitHub Releases 发布。
- **边界公开**：许可证、[更新日志](./CHANGELOG.md)、[路线图](./ROADMAP.md) 和 [Issues](https://github.com/Jamailar/Beav/issues) 均可查。

## Agent 插件（正式版）

Beav Creator 插件让 Codex Desktop 或 WorkBuddy 通过 MCP 连接本机 Beav，调用已开放的工作区与媒体工具，也可把任务交给 Beav 内部 Agent；用户仍在 Beav UI 中查看、审批和编辑结果。

先安装并启动 Beav（CLI 用户运行 `beav open`），再把对应指令发给宿主 Agent：

**Codex**

```text
/goal Read https://beav.pro/agent to install the Beav Creator plugin and set up a new task for me.
```

**WorkBuddy**

```text
Read https://beav.pro/workbuddy to install the Beav Creator plugin and connect it to my local Beav workspace.
```

安装完成后，直接在 Codex 或 WorkBuddy 中描述任务即可。宿主与 Beav 须运行在同一台电脑；浏览器 UI 只供用户操作，不作为 Agent 控制通道。以上入口面向正式版，不适用于 2.5.0 源码快照。

## 项目历史与维护

RedBox 已更名为 **Beav**；原有本地数据和工作空间不受影响。公开源码基线为 Tauri + Rust 2.5.0；后续正式版继续在私有仓库中迭代。公开仓库保留清理后的开发历史，后续公开内容通过 PR 审查合并。

<p align="center">
  <!-- maintenance-days:start -->
  <img src="https://img.shields.io/badge/%E8%87%AA%202025%20%E5%B9%B4%206%20%E6%9C%88%E8%B5%B7-%E5%B7%B2%E6%8C%81%E7%BB%AD%E7%BB%B4%E6%8A%A4%20492%20%E5%A4%A9-EA580C?style=flat-square&amp;labelColor=9A3412" alt="本项目自 2025 年 6 月起，已持续维护 492 天">
  <!-- maintenance-days:end -->
</p>

<p align="center">
  <!-- release-stats:start -->
  <a href="https://github.com/Jamailar/Beav/releases"><img src="https://img.shields.io/badge/%E5%B7%B2%E5%8F%91%E5%B8%83%20Release-84%20%E4%B8%AA-2563EB?style=flat-square&amp;labelColor=1D4ED8" alt="已发布 84 个 Release 版本"></a>
  <a href="https://github.com/Jamailar/Beav/releases"><img src="https://img.shields.io/badge/%E7%B4%AF%E8%AE%A1%E5%AE%89%E8%A3%85%E5%8C%85-668%20%E4%B8%AA-14B8A6?style=flat-square&amp;labelColor=0F766E" alt="累计 668 个安装包"></a>
  <!-- release-stats:end -->
</p>

<p align="center">
  <a href="https://github.com/Jamailar/Beav/releases/latest"><img src="https://img.shields.io/github/v/release/Jamailar/Beav?style=flat-square&color=C56F2C" alt="Latest Release"></a>
  <a href="https://github.com/Jamailar/Beav"><img src="https://img.shields.io/github/stars/Jamailar/Beav?style=flat-square&color=C56F2C" alt="GitHub Stars"></a>
  <a href="https://github.com/Jamailar/Beav/releases"><img src="https://img.shields.io/github/downloads/Jamailar/Beav/total?style=flat-square&color=C56F2C" alt="Release 文件下载次数（非用户数）"></a>
  <a href="https://github.com/Jamailar/Beav/releases/latest"><img src="https://img.shields.io/github/release-date/Jamailar/Beav?style=flat-square&color=6C757D" alt="Release Date"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Source--available-6C757D?style=flat-square" alt="License"></a>
  <a href="https://beav.pro/download"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-6C757D?style=flat-square" alt="Platform"></a>
</p>

安装包统计指发布资产文件数量，下载统计指 Release 文件下载次数，均不代表用户数或活跃用户数。

## 社区与媒体资料

- [官网](https://beav.pro/) · [下载](https://beav.pro/download) · [使用指南](https://beav.pro/docs)
- [GitHub Releases](https://github.com/Jamailar/Beav/releases) · [问题反馈](https://github.com/Jamailar/Beav/issues)
- [Bilibili 视频教程](https://www.bilibili.com/video/BV12LNn6nEem/)
- 媒体介绍请统一使用 **Beav** 和 **https://beav.pro/**；注明“Tauri + Rust 2.5.0 源码快照 + 持续更新的桌面正式版”，不要将 2.8 功能写成公开源码能力。
- 可引用本页的[采集演示](./images/plugin-save-xiaohongshu.gif)、[产品图标](./images/beav-icon.png)与产品截图；媒体及授权联系：[jambahailar@gmail.com](mailto:jambahailar@gmail.com)。

Beav 由[第二定律工作室](https://hyperchaos.dev/)开发和维护，开发者：[JambaHailar](https://x.com/JambaHailar)。

<p align="center">
  <img src="./images/beav-discussion-group.jpg" alt="加入 Beav AI 创作交流群" width="30%">
</p>

## 许可证

- **公开源码**：适用 [Beav 非商业源码许可](./LICENSE)。保留现有非商业限制；商业使用、商业分发或集成需事先联系 [jambahailar@gmail.com](mailto:jambahailar@gmail.com) 获得书面授权。这是 source-available 许可，不是标准 MIT，也不符合 [OSI 开源定义](https://opensource.org/osd)。
- **正式安装版**：适用应用内《Beav 用户协议》以及购买页面所列的个人版、团队版和服务权益。安装包在 Releases 提供下载，不意味着受本仓库源码许可授权；源码非商业限制也不用于替代安装版的使用条款。内容及 AI 产物的商业使用仍须遵守素材授权和所用服务条款。
- **第三方组件**：保留各自许可证与版权声明。

## 合作伙伴

### 商务合作

如有品牌合作、行业方案、产品集成或其他商务合作意向，欢迎发送邮件至 [jambahailar@gmail.com](mailto:jambahailar@gmail.com)。

### 经销代理

如希望成为 Beav 的经销或代理合作伙伴，请填写 [Beav 经销代理合作申请表](https://my.feishu.cn/share/base/form/shrcnYe6rZBbfQNvgeDIEHClWUc)。

## 友情赞助

<p>
  <a href="https://www.ipwo.net/?ref=githubJamailar">
    <img src="./images/ipwo-sponsor.png" alt="IPWO 住宅代理" width="100%">
  </a>
</p>

<p><small>
IPWO 提供全球住宅IP资源，支持多地区 IP 环境访问，为自动化任务执行、海外服务测试等场景提供灵活的网络支持。<br>
浏览器自动化与智能应用开发场景中，不同地区的网络环境适配是开发测试过程中的常见需求，IPWO全球代理支持免费测试，9折优惠码“0203”<br>
<a href="https://www.ipwo.net/?ref=githubJamailar">访问IPWO入口</a>
</small></p>

## 友情链接

- [Linux.do](https://linux.do/)
