# `shared/`

本目录定义前后端都会依赖的轻量共享协议和常量。

## Current Files

- `localAsset.ts`: 本地资产 URL 与路径转换
- `manuscriptFiles.ts`: 稿件扩展名和 package 类型
- `modelCapabilities.ts`: 模型能力识别与输入能力
- `modelProfiles.json`: 模型能力规则数据
- `redboxVideo.ts`: 官方视频模式和模型映射

## Rules

- 跨前后端、跨页面都会用到的协议优先放这里。
- 不要把页面私有工具塞进 `shared/`。
- 改共享协议要搜索 host、renderer、脚本三侧调用。
