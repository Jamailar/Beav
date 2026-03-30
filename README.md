<p align="center">
  <img src="./images/RedBox.jpg" alt="RedBox" width="25%">
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
  <strong>面向小红书创作者的本地化 AI 创作工作台</strong><br>
  <em>知识采集 | 灵感生成 | RedClaw 自动化执行 | 稿件与配图联动 | 后台持续运行</em>
</p>

<p align="center">
  <a href="https://github.com/Jamailar/RedBox/releases">
    <img src="https://img.shields.io/badge/⬇️%20立即下载-最新版本-E11D48?style=for-the-badge&logo=github&logoColor=white" alt="Download" height="46">
  </a>
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
[功能截图](#功能截图) ·
[快速开始](#快速开始) ·
[社区](#社区)

</p>

---

## 项目概览

**RedBox (RedConvert)** 是一个专注小红书创作流程的桌面端 AI 工作台，打通：插件采集、知识库、创作、自动化与媒体管理全链路。

## 核心功能

1. Chrome 插件采集：小红书笔记 / 文章、YouTube 视频、网页链接、选中文字
2. 本地知识库与检索
3. 多空间隔离
4. 随机漫步灵感生成
5. 稿件编辑器 + AI 辅助
6. 智囊团与群聊协作
7. RedClaw 单会话自动化执行台
8. 生图与媒体库联动
9. 封面图生成（模板图 + 底图 + 标题组）
10. 后台定时/长周期任务执行

## 功能截图

### RedClaw
![RedClaw](./images/redclaw.png)

### 稿件创作
![Manuscripts](./images/darft.png)

### 知识库
![Knowledge](./images/knowledge.png)

### 随机漫步
![Wander](./images/wander.png)

### AI 智囊团
![Advisors](./images/advisor.png)

### 创意群聊
![Group Chat](./images/groupchat.png)

### 封面图生成
![Cover Generation](./images/gen_cover.jpg)

## 快速开始

1. 在 [Releases](https://github.com/Jamailar/RedBox/releases) 下载并安装。
2. 打开 `设置 -> AI`，填写 Endpoint / Key / Model。
3. 测试连接并保存。
4. 安装并加载 `Plugin/` 里的 Chrome 扩展。
5. 从 `浏览器插件 -> 知识库 -> 稿件/RedClaw` 开始使用。

## 社区

- [GitHub Issues](https://github.com/Jamailar/RedBox/issues)
- [GitHub Discussions](https://github.com/Jamailar/RedBox/discussions)

## 更新日志

### v1.7.9 (2026-03-22)
- 修复漫步模式 AI 调用链路：
  - 单次调用时显式关闭 Qwen 思考模式，避免无效长时间推理
  - 增强漫步请求日志与超时控制，便于定位模型调用问题
- 优化 RedClaw 工具调用时间线：
  - 工具调用条目压缩为更紧凑的一行小字样式，降低视觉占用
- 优化漫步页头部：
  - 将标题、说明与模式开关融合为单行，整体高度更低

### v1.7.8 (2026-03-21)
- 性能优化（来自 `v1.7.6..HEAD` 提交）：
  - 主进程改为先开窗、再异步初始化后台服务，降低冷启动阻塞
  - App 页面改为懒加载并增加加载占位，减少首屏与切换 Tab 的加载压力
- 设置页模型管理增强：
  - 新增 AI 模型列表拉取与搜索能力，提升模型选择稳定性
- YouTube 采集链路增强：
  - 新增全局剪贴板 YouTube 链接捕获入口
  - 采集前强制执行 yt-dlp 可用性检查
- 发布流程改进：
  - 发布脚本支持自动写入 Release Notes
  - Release Notes 默认提取 README 对应版本条目，缺失时回退到最近提交摘要

### v1.7.6 (2026-03-21)
- 新增首次打开逐步引导（Tippy.js），明确推荐使用顺序
- 漫步结果页新增“开始创作”，可一键把灵感与素材投喂给 RedClaw 自动创作
- 修复左下角版本号显示为旧值的问题，改为动态读取应用版本
- 统一 MCP 客户端版本上报为 package 版本，避免发布后版本不一致

### v1.7.5 (2026-03-21)
- 修复笔记识别与刷新链路
- 增强当前打开笔记优先解析
- 优化图文/视频判定
- 提升采集一致性
