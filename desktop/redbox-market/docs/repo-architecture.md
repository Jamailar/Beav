# RedBox Market Repo Architecture

## 设计目标

这个仓库不是“素材堆放区”，而是 RedBox 的公开市场源仓库。它必须同时满足：

1. 官方和社区资产共存
2. 包类型清晰
3. 提交、审核、安装、升级路径稳定
4. 客户端可以按 kind 精准搜索和安装
5. 高风险资产与低风险资产分级治理

## 推荐目录结构

```text
redbox-market/
  README.md
  docs/
    repo-architecture.md
  registry/
    README.md
    index.json
    kinds/
      member-pack.json
      skill-pack.json
      richpost-theme-pack.json
      longform-layout-pack.json
      cover-template-pack.json
      persona-pack.json
      workflow-pack.json
      motion-pack.json
      react-element-pack.json
  packages/
    README.md
    official/
      README.md
      member-pack/
      skill-pack/
      richpost-theme-pack/
      longform-layout-pack/
      cover-template-pack/
      persona-pack/
      workflow-pack/
      motion-pack/
      react-element-pack/
    community/
      README.md
  schemas/
    README.md
    common/
      README.md
    kinds/
      README.md
  submissions/
    README.md
```

## 为什么这样分

### `registry/`

这里不放具体素材，而放“市场索引”。

职责：

- 提供每种 package kind 的列表
- 给客户端搜索、筛选、排序
- 标记官方 / 社区 / 审核状态 / 风险等级
- 作为“可安装白名单”

这意味着客户端不应该直接相信任意 GitHub 链接，而应该以 `registry/` 里的记录为准。

### `packages/`

这里放实际包内容。

统一分两层：

- `packages/official/`
- `packages/community/`

推荐规则：

- 官方包直接放到 `packages/official/<kind>/<slug>/`
- 社区包走作者命名空间，例如：
  `packages/community/<author>/<kind>/<slug>/`

这个骨架里先只创建到 `community/`，不预设具体作者目录，避免假数据。

### `schemas/`

市场不能靠文档口头约定，必须靠 schema。

职责：

- 约束各类 package 的 manifest 字段
- 给 CI 做自动校验
- 给客户端做安装前校验
- 为未来版本升级提供兼容边界

### `submissions/`

专门给投稿流程留位置。

职责：

- 说明社区投稿方式
- 区分自动审核和人工审核
- 说明许可证、版权、敏感内容和执行权限要求

## 各类 package 的建议职责

### 1. `member-pack`

适合放：

- 团队成员模板
- 顾问角色
- 行业专家角色
- 平台运营角色

对应当前 RedBox：

- `prompts/library/runtime/advisors/templates/*.json`

风险级别：低

### 2. `skill-pack`

适合放：

- 可安装技能
- 限定运行时能力包
- 带 hooks / allowedTools / argumentHint 的技能

对应当前 RedBox：

- `skills/`
- `builtin-skills/`
- `skills:market-install`

风险级别：高  
必须人工审核。

### 3. `richpost-theme-pack`

适合放：

- 图文主题
- 小红书图文样式预设
- 页面配色与字体预设

对应当前 RedBox：

- 当前代码里的 `richpostThemeId`

注意：

- 这类资产在正式市场化前，应该先从 Rust 硬编码 catalog 外置成文件协议。

风险级别：低

### 4. `longform-layout-pack`

适合放：

- 长文阅读母版
- 公众号长文母版
- 版式指令与布局预设

对应当前 RedBox：

- 当前代码里的 `longformLayoutPresetId`

注意：

- 也应先从 Rust catalog 外置成文件协议。

风险级别：低

### 5. `cover-template-pack`

适合放：

- 封面版式
- 标题区 / 主图区 / 安全边距模板
- 系列封面风格

风险级别：低

### 6. `persona-pack`

适合放：

- 平台写作风格
- 行业语气风格
- 品牌语调模板

对应当前 RedBox：

- `prompts/library/personas/`

风险级别：低

### 7. `workflow-pack`

适合放：

- RedClaw 工作流
- 跨平台改写流
- 行业运营方案
- 内容生产 SOP

对应当前 RedBox：

- `prompts/library/runtime/redclaw/`

风险级别：中

### 8. `motion-pack`

适合放：

- Remotion 动画模板
- 动画节奏预设
- 过渡场景
- 可复用动效元素
- 标题动画 / 字幕动画 / 卡片入场动画

对应当前 RedBox：

- `remotion-elements/`
- `remotion.scene.json`
- Remotion 相关技能与生成链路

建议：

- 默认先支持“数据型 / 资产型” motion pack
- 不要一开始就允许任意复杂执行代码

风险级别：中  
如果包含可执行代码，则升为高风险。

### 9. `react-element-pack`

适合放：

- React 组件块
- 富文本图文块
- 信息卡片组件
- 专题页模块
- 图文 / 长文 / 视频编辑器里的可插拔 UI 元素

建议：

- 这一类默认按高风险处理
- 因为它天然带执行代码
- 只允许经过人工审核、CI 构建和依赖检查的包进入 registry

风险级别：高

## 官方与社区包的统一原则

官方与社区不要走两套协议，只在 metadata 上区分：

- `channel`: `official` / `community`
- `reviewStatus`: `approved` / `pending` / `rejected`
- `riskLevel`: `low` / `medium` / `high`

这能保证：

- 客户端安装逻辑统一
- 市场搜索逻辑统一
- 审核和展示策略可配置

## 客户端安装建议

客户端不要直接读取这个仓库里的所有文件，而是：

1. 先读取 `registry/index.json`
2. 再读取对应 kind 的 registry 清单
3. 用户点击安装时，按 registry 记录定位到具体 package
4. 下载并校验 manifest / schema / 版本
5. 安装到本地对应目录

## 对当前 RedBox 的落地映射

### 立即适合接市场的

- 成员模板
- 技能
- persona

### 需要先外置 catalog 的

- richpost 主题
- longform 母版

### 需要先定义更严格 contract 的

- motion pack
- react element pack

## 推荐推进顺序

1. `member-pack`
2. `richpost-theme-pack`
3. `longform-layout-pack`
4. `cover-template-pack`
5. `persona-pack`
6. `skill-pack`
7. `workflow-pack`
8. `motion-pack`
9. `react-element-pack`

这个顺序的核心原因是：

- 越靠前，越容易标准化，越适合社区快速贡献
- 越靠后，越涉及执行代码、运行时权限和复杂审核
