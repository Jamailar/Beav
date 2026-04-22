# RedBox Market

这是 RedBox 市场仓库的本地镜像骨架，用来在主项目里参考结构、提前设计协议，并同步未来公开市场仓库的目录方案。

目标：

- 同时承载官方能力和社区能力
- 用统一 package contract 管理不同类型资产
- 支持搜索、审核、安装、升级、下架
- 优先覆盖当前 RedBox 已经适合市场化的资产类型

当前建议支持的 package kind：

- `member-pack`
- `skill-pack`
- `richpost-theme-pack`
- `longform-layout-pack`
- `cover-template-pack`
- `persona-pack`
- `workflow-pack`
- `motion-pack`
- `react-element-pack`

目录说明见：

- [docs/repo-architecture.md](docs/repo-architecture.md)

## 顶层目录

- `registry/`: 市场索引与分类清单
- `packages/`: 官方与社区包的实际内容
- `schemas/`: 各类包的 schema 约定
- `submissions/`: 投稿与审核入口说明
- `docs/`: 仓库架构与治理文档

## 使用方式

这个目录当前不是正式市场源，而是主项目内的参考镜像。

正式市场仓库路径：

- `/Users/Jam/LocalDev/GitHub/RedBox-Market`

建议使用规则：

1. 先在正式市场仓库维护目录、包、registry 和 README
2. 主项目中的这个目录只保留为结构参考和协议对照
3. 如果主项目要读取市场内容，优先读取正式市场仓库，而不是这个镜像目录

## 项目读取约定

项目侧建议按下面顺序读取市场仓库：

1. 读取 `registry/index.json`
2. 根据 package kind 读取 `registry/kinds/<kind>.json`
3. 从 registry 记录中定位到 `packages/` 下的真实包目录
4. 读取包内 `manifest.json` 或对应主定义文件
5. 通过 `schemas/` 做安装前校验
6. 校验通过后安装到本地运行目录

## 包类型与建议安装目标

- `member-pack` -> 成员模板目录
- `skill-pack` -> `skills/` 或用户技能目录
- `richpost-theme-pack` -> 图文主题目录
- `longform-layout-pack` -> 长文母版目录
- `cover-template-pack` -> 封面模板目录
- `persona-pack` -> persona 目录
- `workflow-pack` -> RedClaw / 工作流目录
- `motion-pack` -> Remotion 动画与元素目录
- `react-element-pack` -> React 元素与组件包目录

## 同步说明

这个镜像目录目前是从正式市场仓库设计同步过来的。

如果以后正式市场仓库继续演进，建议优先修改：

- `/Users/Jam/LocalDev/GitHub/RedBox-Market`

再视情况把关键结构同步回当前目录，避免主项目内的参考骨架与真实市场仓库脱节。
