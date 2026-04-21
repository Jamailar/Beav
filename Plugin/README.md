# RedBox Chrome 插件

这个目录提供一个可直接加载的 Chrome / Edge 扩展，用来把外部网页内容保存到 RedBox 桌面端知识库。

## 当前支持

- 小红书笔记 / 文章详情页
- YouTube 视频页 / Shorts 页
- 任意网页链接收藏
- 任意网页选中文字摘录（右键菜单）
- 自动检查插件更新

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
- 桌面端会在本地开启 `http://127.0.0.1:31937/api/knowledge` 供插件写入知识库。

## 使用方式

- 在小红书详情页打开插件，点击“保存小红书笔记 / 文章”
- 在 YouTube 视频页打开插件，点击“保存 YouTube 视频”
- 在任意网页中选中文字，右键点击“保存选中文字到 RedBox”
- 在任意网页打开插件，点击“保存当前页面链接”
- 打开插件 popup 可看到当前版本、开源仓库中的最新版本，并可手动触发“立即检查更新”
- 检测到新版本后，点击“打开更新源”会跳转到开源仓库的 [Plugin 目录](https://github.com/Jamailar/RedBox/tree/main/Plugin)，重新加载扩展即可完成更新

## 备注

- 插件只负责采集，不承载桌面端 AI 工作流。
- 知识整理、漫步、RedClaw 创作仍在桌面端完成。
- 自动更新检查会在插件安装、浏览器启动和后台定时任务中执行；更新源固定为开源仓库 `Jamailar/RedBox` 的 `Plugin/manifest.json`。
