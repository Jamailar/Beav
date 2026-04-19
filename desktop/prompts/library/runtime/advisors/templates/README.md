# Advisor Member Templates

这个目录用于维护“团队成员模板”。

前端会在团队页面的成员创建流程里自动读取这里的所有 `*.json` 文件，并展示为“模板创建”列表。

## 前端入口

- 团队页右上角 `新建`
- 选择 `从模板添加成员`
- 系统会读取本目录下的模板文件并展示出来

如果你在开发过程中想手动增加模板数量，不需要改前端代码，也不需要改 Rust 列表逻辑，直接把新的模板文件放进下面这个目录即可：

`prompts/library/runtime/advisors/templates/`

## 外部来源模板

我已经把一批从 `msitarzewski/agency-agents` 挑选出来、适合团队成员协作的原始 Markdown 人设放进了这里：

`prompts/library/runtime/advisors/templates/agency-agents-raw/`

说明：

- 这个子目录里保存的是原始来源 `md`
- 前端不会直接读取这些 `md`
- 真正给应用使用的，是根目录下对应的 `json` 模板
- 如果你后面还想继续从外部仓库导入，建议也保留一份原始 `md` 在这个子目录里，再额外补一个同名用途的 `json`

## 文件规则

- 一个模板对应一个 `json` 文件
- 目录当前按平铺读取，不扫描子目录
- 文件名会作为默认 `id`
- 如果文件里的 `id` 为空，会自动回退到文件名
- 新模板请直接放在当前目录，不要放到子文件夹里，否则不会被读取

## 模板格式

```json
{
  "id": "content-strategist",
  "name": "内容策略师",
  "avatar": "🧭",
  "description": "负责选题、栏目结构、内容节奏和账号定位。",
  "category": "内容",
  "tags": ["选题", "定位", "策划"],
  "personality": "擅长把模糊方向拆成清晰的内容策略与执行节奏",
  "knowledgeLanguage": "中文",
  "systemPrompt": "你是团队里的内容策略师..."
}
```

## 字段说明

- `id`: 模板唯一标识，可选
- `name`: 模板名称，必填
- `avatar`: 头像，可以是 emoji 或图片地址，可选
- `description`: 模板简介，显示在模板列表里，可选
- `category`: 模板分类，可选
- `tags`: 模板标签数组，可选
- `personality`: 创建成员时的一句话描述，可选
- `knowledgeLanguage`: 成员知识库语言，可选，默认 `中文`
- `systemPrompt`: 成员系统提示词，可选

## 新增模板的方法

1. 在 `prompts/library/runtime/advisors/templates/` 下新增一个 `*.json` 文件
2. 参考本目录现有示例填写字段
3. 保证 JSON 格式合法
4. 回到应用里的“从模板添加成员”弹窗，点击一次“刷新模板”即可看到新模板

当前可直接参考的示例：

- `prompts/library/runtime/advisors/templates/content-strategist.json`
- `prompts/library/runtime/advisors/templates/growth-analyst.json`

已经从 `agency-agents` 转成可直接使用的模板包括：

- `agency-product-manager.json`
- `agency-product-trend-researcher.json`
- `agency-ux-researcher.json`
- `agency-brand-guardian.json`
- `agency-content-creator.json`
- `agency-growth-hacker.json`
- `agency-xiaohongshu-specialist.json`
- `agency-wechat-official-account.json`
- `agency-zhihu-strategist.json`
- `agency-douyin-strategist.json`
- `agency-bilibili-content-strategist.json`
- `agency-video-optimization-specialist.json`
