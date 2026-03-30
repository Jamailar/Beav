# RedBox Chrome 插件

这个目录提供一个可直接加载的 Chrome / Edge 扩展，用来把外部网页内容保存到 RedBox 桌面端知识库。

## 当前支持

- 小红书笔记 / 文章详情页
- YouTube 视频页 / Shorts 页
- 任意网页链接收藏
- 任意网页选中文字摘录（右键菜单）

## 加载方式

1. 打开 Chrome 或 Edge。
2. 进入扩展管理页：
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择当前仓库里的 [Plugin](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin) 目录。

## 使用前提

- RedBox 桌面端必须已经启动。
- 桌面端会在本地开启 `http://127.0.0.1:23456` 供插件写入知识库。

## 使用方式

- 在小红书详情页打开插件，点击“保存小红书笔记 / 文章”
- 在 YouTube 视频页打开插件，点击“保存 YouTube 视频”
- 在任意网页中选中文字，右键点击“保存选中文字到 RedBox”
- 在任意网页打开插件，点击“保存当前页面链接”

## 备注

- 插件只负责采集，不承载桌面端 AI 工作流。
- 知识整理、漫步、RedClaw 创作仍在桌面端完成。
