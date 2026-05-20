---
name: cosyvoice-ssml
description: 内部技能，仅用于数字人 / VideoRetalk / 资产库角色口播视频链路中的 CosyVoice TTS 子步骤。普通 AI 聊天、普通音频、普通短视频、产品视频或广告视频请求不得直接调用本技能；这些视频请求必须先走 video-director。只有 video-director 已确认这是数字人口播，且需要把已批准的台词合成为角色驱动音频时，才可激活本技能。
allowedRuntimeModes: [chatroom, redclaw, image-generation, audio-editor]
allowedTools: [workflow]
activationScope: turn
autoActivate: false
activationHint: 内部技能。仅当当前轮已经由 `video-director` 判定为资产库角色数字人 / VideoRetalk / talking-head 口播视频，并且已确认台词、角色 voiceId 与参考视频，且 TTS 模型是 CosyVoice 系列时，才可调用 `Operate(resource="skills", operation="invoke", input={ "name": "cosyvoice-ssml" })`。如果用户在普通 AI 聊天里要求“做口播视频 / 生成视频 / 产品视频 / 广告片 / 短视频”，不要调用本技能，必须先调用 `video-director`。如果只是普通音频或旁白，不要把本技能当成入口。
contextNote: 这是数字人口播视频链路里的 CosyVoice SSML 子技能，不是通用短视频口播导演。技能激活不是文本转换工具，不会返回加工结果；只能在 video-director 的数字人 / VideoRetalk 子流程中，把已批准的角色台词拆成可表演的 CosyVoice TTS 片段。每个片段用 CosyVoice 支持的 SSML 标签表达语气、节奏和读法，并作为 voice.speech.segments 的一个 item。只能使用 `<speak>`、`<break/>`、`<sub>`、`<phoneme>`、`<soundEvent/>`、`<say-as>`；不要使用 `<prosody>`、MiniMax `<#0.6#>` 或 emotion 字段。
maxPromptChars: 32000
hookMode: inline
hidden: true
---

# CosyVoice SSML 表演导演

仅当当前任务已经是 `video-director` 管理下的数字人 / VideoRetalk / 资产库角色 talking-head 口播视频，并且选中的 TTS 模型是 CosyVoice 时，使用这个技能。

普通 AI 聊天里的“做一个口播视频 / 生成视频 / 短视频 / 产品视频 / 广告片”不能直接进入本技能。必须先激活 `video-director`，由它完成视频脚本、分镜、确认、角色与音频驱动链路。普通音频、普通旁白、普通 TTS 也不能用本技能作为入口。

## 技能激活语义

`skills.invoke` 只会把本技能说明加入当前轮上下文，不会替你转换文本，也不会返回 SSML。

只有在数字人口播视频链路中激活后，你必须自己完成这三步：

1. 根据已经批准的数字人口播台词拆出角色表演片段：开头、场景、信息推进、重点、收束等。
2. 为每个片段写出一个完整 `<speak rate="..." pitch="..." volume="...">...</speak>` SSML，并给这个片段写一个简短 `prompt`。
3. 立即调用一次 `voice.speech` 生成音频。

不要再次调用 `cosyvoice-ssml` 等待结果；不要说“缺少 SSML 加工结果”；不要创造 `cosyvoice-ssml-turn` 之类不存在的技能名。

你的任务不是展示 SSML 知识，而是把最终要朗读的文本变成一次可执行的 `voice.speech` 请求：

- 先判断文本类型、听众、商业目标、卖点结构和口播节奏。
- 再逐句决定怎么读：哪里慢、哪里轻、哪里强调、哪里停顿。
- 在 Agent 音频创作里，多句、换行、短视频带货、自媒体口播、产品讲解、知识分享、种草测评或用户要求语气时，必须产出 `<speak>...</speak>` SSML。
- 长文本、多段文本、带货口播、自媒体口播、种草测评、产品讲解、广告口播、教程和任何明显有信息推进的文本，必须使用 `segments`。每个 segment 是一个独立 CosyVoice 合成片段，media runtime 会自动合并最终音频。
- 只有极短、中性、单一语气的一句话，才可以使用单个 `input`。
- 只有用户明确要求“不要 SSML / 直接纯文本”，或者文本就是极短中性一句话时，才可以不用 SSML。
- 保留用户原文含义；除非用户要求改写，否则不要改词。
- 最终只调用一次 `voice.speech`，不要逐句多次调用工具，也不要手动拼接音频。

## 可用模型

只在这些 CosyVoice 系列模型上使用本技能：

- `cosyvoice-v3.5-plus`
- `cosyvoice-v3.5-flash`
- `cosyvoice-v3-plus`
- `cosyvoice-v3-flash`
- `cosyvoice-v2`

音色 ID 和模型绑定。`cosyvoice-v3.5-plus` 通常要使用复刻或设计出的 CosyVoice 音色 ID，不要拿 MiniMax 系统音色 ID 来合成。

## 最终输出格式

短文本最终调用 `voice.speech` 时，可以使用单个 `input`：

```json
{
  "model": "cosyvoice-v3.5-plus",
  "voiceId": "voice_xxx",
  "input": "<speak rate=\"0.9\" pitch=\"0.95\" volume=\"60\">完整 SSML 文本</speak>",
  "prompt": "请用温柔、平稳、有耐心的语气朗读。",
  "language_hints": ["zh"],
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

长文本最终调用 `voice.speech` 时，必须使用 `segments`，每段都有自己的 `input` 和 `prompt`，由 media runtime 合并最终音频：

```json
{
  "model": "cosyvoice-v3.5-plus",
  "voiceId": "voice_xxx",
  "segments": [
    {
      "input": "<speak rate=\"1.08\" pitch=\"1.06\" volume=\"68\">第一段 SSML。</speak>",
      "prompt": "开头抓注意力，清楚、有记忆点，但不要喊。",
      "pauseAfterSeconds": 0.4
    },
    {
      "input": "<speak rate=\"0.98\" pitch=\"1.0\" volume=\"64\">第二段 SSML。</speak>",
      "prompt": "卖点解释更稳定可信，语气自然、有说服力。",
      "pauseAfterSeconds": 0.8
    }
  ],
  "language_hints": ["zh"],
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

硬约束：

- `input` 或每个 `segments[].input` 只能是最终要送给 TTS 的 SSML，不要包含分析、注释、分镜、括号说明或“语气：温柔”这类元信息。
- SSML 属性里的引号在逻辑字符串里必须是真实 `"`，不要把用户可见文本写成 `\"`。JSON 序列化会自动处理转义。
- CosyVoice `prompt` 是可用能力。单 `input` 时写全局声音风格；`segments` 时每个 segment 都要写本段声音风格。
- CosyVoice 不使用 `emotion`、`voice_setting.emotion`、MiniMax `<#0.6#>`、`(laughs)`、`(sighs)`、`(breath)`。
- 绝对不要输出 `<prosody>`。如果你脑中想写 `<prosody rate="0.9" volume="medium">`，应改成 `<speak rate="0.9" volume="60">...</speak>`。
- `rate`、`pitch`、`volume` 都是 CosyVoice `<speak>` 属性，不是 MiniMax segment 控制。不要把 MiniMax 的 `pitch:-2`、`pitch:-1`、`pitch:0` 写进 CosyVoice SSML。
- `pitch` 必须是 `0.5-2` 的正数倍率，不能是负数、不能是 `0`、不能写 `-1` / `-2`。低沉用 `0.86-0.96`，自然用 `0.96-1.04`，明亮用 `1.04-1.16`。
- `rate` 必须是 `0.5-2` 的正数倍率。慢读常用 `0.76-0.92`，自然叙述常用 `0.92-1.04`，轻快口播常用 `1.04-1.16`。
- `volume` 必须是 `0-100` 数字，不能写 `medium`、`loud`、`soft`，也不能写 `0.8`、`1.0` 这种 0-1 小数音量。普通口播常用 `58-72`，低声特殊氛围也通常不要低于 `45`。
- 每一个 `<speak>` 都必须显式写 `rate`、`pitch`、`volume` 三个数字属性。除非用户明确要求保留原始 SSML，否则不要输出没有参数的 `<speak>`。
- 多句带货口播、自媒体口播、种草测评、产品讲解、教程和任何需要“语气”的文本，不能只加 `<break/>`。必须用 `<speak rate="..." pitch="..." volume="...">` 表达语气区块变化。
- 多句口播尽量使用一次 `voice.speech` 的 `segments` 数组。不要把多句内容塞进一个巨大 `<speak>`，也不要自己连续调用多次 `voice.speech`。

## 合格输出标准

激活本技能后，不能只把原文机械包进 `<speak>`。合格输出必须同时满足“合法、可朗读、有表演设计、可执行”四个标准。

### 1. 合法

每个 CosyVoice SSML input 必须是可接受的 SSML：

- 最外层是一个或多个并列 `<speak>...</speak>`，不能嵌套 `<speak>`。
- 只使用 CosyVoice 支持的标签：`<speak>`、`<break/>`、`<sub>`、`<phoneme>`、`<soundEvent/>`、`<say-as>`。
- `<break/>` 必须是自闭合标签，时间使用 `ms` 或 `s`，不要超过合理范围。
- `<speak>` 的 `rate` / `pitch` 使用 `0.5-2` 数字，`volume` 使用 `0-100` 数字；`volume="1.0"` 不是正常音量，而是几乎静音。
- `<speak pitch>` 只能使用正数倍率。`pitch="-2"`、`pitch="-1"`、`pitch="0"` 都是非法 CosyVoice SSML；它们只属于 MiniMax segment 的 pitch 语义。
- 不包含 `<prosody>`、`<emphasis>`、MiniMax `<#0.6#>`、`emotion`、括号表演说明或 Markdown。

### 2. 可朗读

`input` 里只能放会被朗读的正文和 SSML 标签：

- 不要把“语气：”“停顿：”“这里强调”等分析文字写进正文。
- 不要输出列表说明、JSON 外的解释、草稿、方案、检查清单。
- 保留用户要表达的意思；只有为了朗读自然，才可以把符号和快捷键转成口语，例如把 `Option ⌥ + Command ⌘ + Delete ⌫` 读成 `Option 加 Command 加 Delete`。
- 对验证码、日期、电话、金额、ID、多音字、缩写等容易读错的内容，优先用 `<say-as>`、`<phoneme>`、`<sub>` 修正。

### 3. 有细颗粒度表演设计

SSML 必须体现文本的内容结构，而且标签颗粒度要细。不能只做段落级或整篇级控制。

- 所有 `<speak>` 必须带 `rate`、`pitch`、`volume`。只有 `<break/>`、没有语速/音高/音量设计，不合格。
- 朗读风格变化要落在 `<speak>` 参数上：压低情绪用较慢 `rate`、较低 `pitch`、较低 `volume`；揭示/强调可略提高 `volume` 或稍放慢；收束要降低速度和音量。
- 开头、重点、转折、列表项、结尾要有不同的节奏处理。
- 多句或多段文本至少要有少量有意义的 `<break/>`，但不要每个标点后都加停顿。
- 长文本要有口播推进：开头抓注意力，中段把卖点或观点讲清楚，结尾自然引导下一步。
- 带货/自媒体/教程类要清晰、稳定、重点前后留短停顿；根据开场钩子、痛点、卖点、证据、福利、CTA 等口播结构调整 `rate`、`pitch`、`volume`。
- 如果只输出 `<speak>原文</speak>`，除非文本极短且用户明确要平读，否则不合格。
- 如果输出 `<speak>原文<break/>原文...</speak>`，但 `<speak>` 没有 `rate/pitch/volume`，或者全篇只有一个固定参数且文本明显有情绪转折，也不合格。
- 对关键词、数字、专名、缩写、快捷键、步骤名、转折词、行动指令等局部内容，优先使用 `<say-as>`、`<sub>`、`<phoneme>` 或局部 `<break/>` 做细标，而不是只依赖全局 `prompt`。
- 如果文本有多句话，每句话都要被单独判断朗读意图；如果一句话内部有多个信息单元，也要在短语级决定是否需要读法修正或微停顿。

### 生成前自检

调用 `voice.speech` 前，必须逐个检查 `input` 和 `segments[].input`。只要有一项不通过，就先在本轮内部修正 SSML，再调用工具。

自检清单：

- 每个片段最外层都是完整 `<speak ...>...</speak>`。
- 没有 `<prosody>`、`<emphasis>`、`emotion`、MiniMax `<#...#>` 或括号表演说明。
- 每个 `<speak>` 都有 `rate`、`pitch`、`volume` 三个属性。
- `rate` 是 `0.5-2` 的正数。
- `pitch` 是 `0.5-2` 的正数；如果看到 `pitch="-2"`、`pitch="-1"`、`pitch="0"`，必须改成 `0.86-1.16` 范围内的 CosyVoice 倍率。
- `volume` 是 `0-100` 的数字；普通口播通常不要低于 `55`，除非用户明确要低声或特殊氛围。
- `prompt` 只描述声音风格，不把 SSML 或正文重复塞进去。

常见映射：

| 朗读意图 | rate | pitch | volume |
| --- | --- | --- | --- |
| 平稳说明 | `0.92-1.02` | `0.96-1.02` | `55-65` |
| 开场钩子 | `1.02-1.14` | `1.02-1.12` | `62-72` |
| 卖点解释 | `0.94-1.04` | `0.98-1.04` | `58-68` |
| 信任背书 | `0.9-1.0` | `0.96-1.02` | `56-66` |
| 清晰教程 | `0.9-1.0` | `0.96-1.04` | `58-68` |
| 轻快口播 | `1.02-1.14` | `1.02-1.12` | `60-72` |

### 4. 可执行

最终必须直接调用一次 `voice.speech`：

- `model` 使用当前 CosyVoice 模型。
- `voiceId` 使用当前请求或已选的 CosyVoice 绑定音色。
- 短文本：`input` 是完整 SSML，`prompt` 是一句简短全局声音风格。
- 长文本：`segments` 是有序片段数组；每个 `segments[].input` 是一个完整 SSML，且每个 `segments[].prompt` 描述这一段的声音风格。
- `pauseBeforeSeconds` / `pauseAfterSeconds` 用于段落边界沉默，由 media runtime 在最终合并时插入。
- `responseFormat` 通常是 `mp3`。
- `waitForCompletion` 为 `true`，除非用户明确只提交异步任务。

### 5. 最小合格示例

用户输入：

```text
在 Mac 上彻底删除文件，不是移到废纸篓。
方法一：快捷键直接永久删除。
选中文件后按：Option ⌥ + Command ⌘ + Delete ⌫。
```

合格 `input`：

```xml
<speak rate="0.92" pitch="0.98" volume="60">在 Mac 上彻底删除文件，<break time="250ms"/>不是移到废纸篓。<break time="450ms"/>方法一：<break time="220ms"/>快捷键直接永久删除。<break time="350ms"/>选中文件后按：<sub alias="Option 加 Command 加 Delete">Option ⌥ + Command ⌘ + Delete ⌫</sub>。</speak>
```

不合格 `input`：

```xml
<speak>在 Mac 上彻底删除文件，不是移到废纸篓。方法一：快捷键直接永久删除。选中文件后按：Option ⌥ + Command ⌘ + Delete ⌫。</speak>
```

原因：只是包了一层 `<speak>`，没有节奏设计，也没有处理快捷键符号的朗读方式。

## 细颗粒度标注原则

CosyVoice SSML 的目标不是“加几个停顿”，而是把可朗读文本变成细颗粒度的表演稿。标注时按这个层级处理：

1. **全文级**：用 `<speak rate="..." pitch="..." volume="...">` 决定整体风格。
2. **段落级**：段落之间用 `<break/>` 或少量并列 `<speak>` 表达明显的语气区块变化。
3. **句子级**：每句话判断是铺垫、解释、强调、转折、揭示、安抚、行动号召还是收束。
4. **短语级**：对重点短语、步骤名、结论、CTA、对比词前后加短停顿。
5. **词/字符级**：对数字、日期、电话、金额、验证码、ID、多音字、缩写、快捷键、品牌名做 `<say-as>`、`<phoneme>`、`<sub>`。

细颗粒度不是密集堆标签。原则是：凡是“模型可能读错、听众需要停一下、语义需要落点、语气需要变化”的位置，都应该有局部标签；普通流水句和自然标点不需要机械加标签。

### 必须细标的位置

以下内容不能只靠纯文本：

- 验证码、订单号、账号、ID：用 `<say-as interpret-as="digits">` 或 `<say-as interpret-as="id">`。
- 日期、时间、金额、电话、计量单位：用对应 `<say-as>`。
- 多音字、专名、外语发音：用 `<phoneme>`。
- 缩写、品牌名、符号、快捷键：用 `<sub>` 转成自然读法。
- 教程步骤名、方法名、关键结论：前后使用 `200ms-500ms` 的局部 `<break/>`。
- 转折词后或重要结论前：使用 `350ms-700ms` 的局部 `<break/>`。
- 章节、段落或情绪转场：使用 `700ms-1200ms` 的 `<break/>`，或少量并列 `<speak>`。

### 颗粒度示例

粗糙，不合格：

```xml
<speak rate="0.92">你的验证码是 10234。请在 5 分钟内输入。</speak>
```

细颗粒度，合格：

```xml
<speak rate="0.9" pitch="0.98" volume="58">你的验证码是：<break time="250ms"/><say-as interpret-as="digits">10234</say-as>。<break time="450ms"/>请在 <say-as interpret-as="measure">5分钟</say-as> 内输入。</speak>
```

粗糙，不合格：

```xml
<speak>去重庆的典当行。</speak>
```

细颗粒度，合格：

```xml
<speak rate="0.92" pitch="0.98" volume="58">去<phoneme alphabet="py" ph="chong2 qing4">重庆</phoneme>的<phoneme alphabet="py" ph="dian3 dang4 hang2">典当行</phoneme>。</speak>
```

## CosyVoice 支持的 SSML

CosyVoice 不是完整 W3C SSML，只能使用下面这些标签。

### `<speak>`

所有内容必须放在 `<speak>...</speak>` 内。支持多个并列 `<speak>`，但不能嵌套。

常用属性：

- `rate`: 语速，范围 `0.5` 到 `2`，默认 `1`。
- `pitch`: 音高，范围 `0.5` 到 `2`，默认 `1`。
- `volume`: 音量，范围 `0` 到 `100`，默认 `50`。这是百分制标尺，不是 `0-1` 小数标尺；短视频口播通常用 `58-72`，低声特殊氛围才用更低值。
- `voice`: 音色覆盖。通常优先用 payload 的 `voiceId`，不要随便写。
- `effect`: `robot`、`lolita`、`lowpass`、`echo`、`eq`、`lpfilter`、`hpfilter`。
- `effectValue`: 配合高级音效。
- `bgm`: 公共可访问的 OSS 背景音乐 URL。
- `backgroundMusicVolume`: 背景音乐音量。

不要使用 `<prosody>`。CosyVoice 的语速、音高、音量主要写在 `<speak>` 上。

正确：

```xml
<speak rate="0.9" volume="60">这句话读得平稳一点。</speak>
```

错误：

```xml
<speak><prosody rate="0.9" volume="medium">这句话读得平稳一点。</prosody></speak>
```

### `<break/>`

用于停顿。

- 短停顿：`<break time="250ms"/>` 到 `<break time="400ms"/>`
- 句间停顿：`<break time="500ms"/>` 到 `<break time="800ms"/>`
- 重点转折或段落切换：`<break time="600ms"/>` 到 `<break time="1000ms"/>`
- 慎用超过 `1200ms` 的停顿，除非用户明确要慢节奏。

### `<sub>`

用于“看起来保留原词，但朗读时替换成更自然的说法”。

```xml
<sub alias="网络协议标准">W3C</sub>
```

适合缩写、品牌、专业术语、外语词和不希望按字面读的内容。

### `<phoneme>`

用于多音字、专名、外语发音。

```xml
<phoneme alphabet="py" ph="chong2 qing4">重庆</phoneme>
```

中文用 `alphabet="py"`，拼音数量必须和汉字数量一致，声调用 `1-5`，轻声用 `5`。

英文可用 `alphabet="cmu"`。

### `<say-as>`

用于控制文本读法。

可用 `interpret-as`：

- `cardinal`: 整数或小数
- `digits`: 逐位数字
- `telephone`: 电话号码
- `name`: 人名
- `address`: 地址
- `id`: ID、昵称、账号
- `characters`: 逐字符
- `punctuation`: 标点
- `date`: 日期
- `time`: 时间
- `currency`: 金额
- `measure`: 单位

示例：

```xml
<say-as interpret-as="digits">10234</say-as>
```

### `<soundEvent/>`

只在用户明确要插入音效，且提供了可公开访问的 OSS WAV URL 时使用。

不要编造音效 URL。不要把普通语气词改成外部音效。

## 表演设计流程

每次生成 SSML 前，按这个顺序思考，但不要把思考过程输出给用户或放入 `input`。

### 1. 判断文本类型

先把文本归类，因为不同文本的节奏不同：

- 短视频带货：开头抓注意力，中段讲卖点和证据，结尾推动行动。
- 自媒体知识口播：结论先行，解释清楚，重点前后留停顿。
- 种草测评：像真实体验分享，语气自然，优缺点和适合人群读清楚。
- 产品功能讲解：功能、步骤、规格和适用场景要读准。
- 直播切片/限时转化：利益点、价格、库存、行动指令要清楚。
- 新闻/事实播报：稳、清楚、少情绪，不要乱加戏。

### 2. 找出口播结构

长文本不要每一句都同一种语气。至少判断这些位置：

- 开头钩子：让听众愿意继续听。
- 痛点/场景：让听众觉得“这和我有关”。
- 核心卖点：讲清楚产品或观点解决了什么。
- 证据/对比：让表达更可信。
- 价格/福利/限制：数字和条件要读准。
- CTA：明确下一步，但不要喊。

如果文本没有明显情绪变化，保持统一风格，不要为了“有 SSML”而过度分块。

### 3. 逐句标注朗读意图

每一句内部先确定一个意图：

- 开场钩子：更快一点、更亮一点，第一句要抓人。
- 痛点/场景：自然、有共鸣，重点前后留短停顿。
- 产品卖点：清楚、笃定，少用夸张语气。
- 使用效果：稍微明亮，读出“具体变化”。
- 价格/优惠：读清楚数字和条件，前后留短停顿。
- 信任背书：稳定、可信，不要像硬广。
- 对比转折：转折前后加停顿，让差异落点清楚。
- 行动号召：速度略快，音量略高，但不要喊。
- 结尾收束：干净明确，少留过长空白。

### 4. 决定 `<speak>` 参数和分块

不要把 `<speak>` 当作单纯的根标签。它是 CosyVoice 里最重要的表演控制标签，必须用它的 `rate`、`pitch`、`volume` 表达当前语气区块。

短文本、中性说明可以只用一个带参数的 `<speak>`。但只要文本超过三句，或出现开头钩子、痛点、卖点、证据、福利、CTA 等多个口播功能区，就应该拆成多个 `segments`。每个 segment 里放一个完整 `<speak>`，并给这个 segment 写自己的 `prompt`。

分块建议：

- 短视频带货：通常 `3-6` 个 segments，开头钩子、痛点场景、核心卖点、证据/对比、福利/CTA 分别控制。
- 自媒体知识口播：通常 `2-5` 个 segments，结论先行、解释展开、例子/步骤、总结引导分别控制。
- 种草测评：通常 `3-5` 个 segments，使用场景、体验感、优缺点或对比、适合人群、购买建议分别控制。
- 直播切片/引流：通常 `2-4` 个 segments，强提醒、利益点、限时条件、行动指令分别控制。
- 对话/多角色：按说话人和意图拆 segment；如果只有一个 CosyVoice 音色，就保持同一 `voiceId`，用 prompt 和 SSML 控制表演。

每个 segment 的 `<speak>` 必须完整，不能嵌套：

```xml
<speak rate="1.08" pitch="1.06" volume="68">先用一句话抓住注意力。<break time="350ms"/></speak><speak rate="0.96" pitch="1.0" volume="62">然后把核心卖点讲清楚，让用户知道为什么值得继续听。</speak>
```

不要每一句都做一个 segment。那会让音频割裂、机械。正确做法是按语气区块拆分，每个区块内部再用 `<break/>`、`<sub>`、`<phoneme>`、`<say-as>` 做细标。

不合格：

```xml
<speak>这款清洁喷雾很适合厨房。<break time="800ms"/>油渍一喷一擦就干净。<break time="800ms"/>现在下单还有优惠。</speak>
```

原因：只加停顿，没有任何 `rate/pitch/volume` 表演设计。

合格：

```json
{
  "segments": [
    {
      "input": "<speak rate=\"1.08\" pitch=\"1.06\" volume=\"68\">厨房油渍难擦，<break time=\"250ms\"/>真的不用再拿钢丝球硬蹭。</speak>",
      "prompt": "短视频开场钩子，直接、有共鸣，第一句抓住注意力。",
      "pauseAfterSeconds": 0.25
    },
    {
      "input": "<speak rate=\"0.98\" pitch=\"1.0\" volume=\"64\">这瓶清洁喷雾喷上去等几秒，<break time=\"300ms\"/>油污会慢慢浮起来，抹布一擦就干净。</speak>",
      "prompt": "产品卖点解释，清楚、可信，强调使用过程和效果。",
      "pauseAfterSeconds": 0.35
    },
    {
      "input": "<speak rate=\"1.04\" pitch=\"1.04\" volume=\"70\">家里经常做饭的，<break time=\"250ms\"/>可以先囤一瓶试试。</speak>",
      "prompt": "结尾行动号召，轻快、有推动力，但不要像喊口号。",
      "pauseAfterSeconds": 0.4
    }
  ]
}
```

### 5. 判断是否允许不用 SSML

在 Agent 音频创作里，默认应该输出 `<speak>`，尤其是多句、换行、带货口播、自媒体口播、产品讲解、教程或需要语气的文本。纯文本只适合极短中性单句，或者用户明确说“不需要 SSML”。

比如用户输入多行教程文本，应按步骤拆成 segments：

```json
{
  "model": "cosyvoice-v3.5-plus",
  "voiceId": "voice_xxx",
  "segments": [
    {
      "input": "<speak rate=\"0.94\" pitch=\"0.99\" volume=\"60\">在 Mac 上彻底删除文件，不是移到废纸篓，有几种方法。</speak>",
      "prompt": "清晰、平稳地说明主题。",
      "pauseAfterSeconds": 0.25
    },
    {
      "input": "<speak rate=\"0.92\" pitch=\"0.98\" volume=\"62\">方法一：<break time=\"220ms\"/>快捷键直接永久删除。<break time=\"350ms\"/>选中文件后按：<sub alias=\"Option 加 Command 加 Delete\">Option ⌥ + Command ⌘ + Delete ⌫</sub>。</speak>",
      "prompt": "教程步骤语气，重点读清楚快捷键。",
      "pauseAfterSeconds": 0.35
    },
    {
      "input": "<speak rate=\"0.9\" pitch=\"0.97\" volume=\"58\">系统会提示：<break time=\"300ms\"/>是否要立即删除？<break time=\"450ms\"/>点击删除后，这个文件不会进入废纸篓。</speak>",
      "prompt": "提醒和结论语气，收束清楚。",
      "pauseAfterSeconds": 0.5
    }
  ],
  "language_hints": ["zh"],
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

注意：可以把快捷键、符号和换行转成更好读的自然文本，但每个 segment 仍然要保留完整 `<speak>` 和必要的 `<break/>`。

## 常用口播参数

这些是起点，不是固定模板。根据文本微调。

使用规则：

- 不能把下表当作“只选一个全篇参数”。长文本要根据语气区块微调。
- 同一篇文本里，相邻区块的变化要克制，通常 `rate` 差值不超过 `0.12`，`pitch` 差值不超过 `0.12`，`volume` 差值不超过 `12`，除非用户明确要强转化或夸张风格。
- 绝对不要把 MiniMax/音频播放器里的 `volume: 0.8` 写成 CosyVoice SSML 的 `volume="0.8"`；CosyVoice SSML 里应写类似 `volume="55"`。
- 痛点、场景共鸣：语速不要太快，给关键词短停顿。
- 卖点、效果、对比：读清楚，略提高 `volume`，但不要喊。
- 价格、优惠、规格：数字要读准，前后给短停顿。
- CTA：可以略提高 `rate`、`pitch`、`volume`，但保持自然，不要像硬广喊麦。
- 结尾收束：干净明确，通常给 `400ms-800ms` 留白即可。
- 如果你发现自己只在 `<break/>` 上做变化，说明还没有完成 CosyVoice 表演设计。

| 场景 | 建议 |
| --- | --- |
| 短视频开场钩子 | `rate="1.04-1.16"`，`pitch="1.02-1.12"`，`volume="64-74"` |
| 痛点/使用场景 | `rate="0.94-1.04"`，`pitch="0.98-1.04"`，`volume="58-68"` |
| 产品卖点解释 | `rate="0.94-1.04"`，`pitch="0.98-1.04"`，`volume="60-68"` |
| 效果/对比呈现 | `rate="0.96-1.08"`，`pitch="1.0-1.08"`，`volume="62-72"` |
| 价格/优惠信息 | `rate="0.9-1.0"`，`pitch="0.98-1.04"`，`volume="60-70"` |
| 信任背书 | `rate="0.9-1.0"`，`pitch="0.96-1.02"`，`volume="56-66"` |
| CTA 结尾 | `rate="1.04-1.16"`，`pitch="1.02-1.1"`，`volume="66-76"` |
| 知识口播总结 | `rate="0.92-1.02"`，`pitch="0.98-1.04"`，`volume="58-68"` |

## 停顿策略

停顿不是标点的机械翻译。只在“听众需要消化”或“表演需要落点”时加。

常用停顿：

- 普通逗号：多数情况下不需要 `<break>`，靠标点即可。
- 重点前：`<break time="300ms"/>`
- 重点后：`<break time="400ms"/>` 到 `<break time="600ms"/>`
- 段落过渡：`<break time="700ms"/>` 到 `<break time="1000ms"/>`
- 情绪下沉：`<break time="900ms"/>` 到 `<break time="1400ms"/>`
- 结尾留白：`<break time="400ms"/>` 到 `<break time="900ms"/>`

不要在每个句号后都加停顿。短视频口播里一旦停顿过密，会显得拖沓，影响信息密度。

## 读法修正策略

优先修正会明显读错或造成歧义的内容。

### 数字

- 验证码、订单号、ID：用 `digits`。
- 金额：用 `currency`。
- 日期：用 `date`。
- 时间：用 `time`。
- 电话：用 `telephone`。
- 普通数量：用 `cardinal` 或保持原文。

### 多音字和专名

已知容易错的多音字，用 `<phoneme>`：

```xml
<phoneme alphabet="py" ph="chong2 qing4">重庆</phoneme>
```

不要对所有中文都加拼音。只修正关键、容易错、用户特别在意的词。

### 缩写和品牌

如果按字母读会不自然，用 `<sub>`：

```xml
<sub alias="人工智能">AI</sub>
```

如果用户需要保留原文显示但改变读法，`<sub>` 比直接改文本更合适。

## 内容类型模板

### 自媒体知识口播

目标：开头给结论，中间解释清楚，结尾给行动建议或关注理由。

做法：

- 开头不要铺垫太久，先说结论或冲突点。
- 概念、步骤、结论前后加短停顿。
- 列表项之间加轻微停顿，避免像读稿。
- 数字、日期、术语用 `say-as` 或 `sub` 修正。

示例：

```xml
<speak rate="1.02" pitch="1.03" volume="66">做短视频口播，<break time="250ms"/>最重要的不是语速快，<break time="300ms"/>而是每一句都让用户知道，为什么要继续听。</speak>
```

### 短视频带货口播

目标：开头抓注意力，中间讲清卖点和信任，结尾推动行动。

做法：

- 开头短促但不要喊。
- 痛点和使用场景要读得像真人经验，不要像念说明书。
- 关键信息前加停顿。
- CTA 可以单独一个 `<speak>`，略快、略亮、音量稍高。

示例：

```xml
<speak rate="1.08" pitch="1.06" volume="70">厨房油渍别再用力刮了。<break time="300ms"/></speak><speak rate="0.98" pitch="1.0" volume="64">这瓶清洁喷雾喷上去等几秒，油污会自己浮起来，抹布一擦就干净。</speak><speak rate="1.08" pitch="1.06" volume="72">经常做饭的，今天可以先囤一瓶。</speak>
```

### 种草测评

目标：像真实使用后分享，既有体验感，也有购买判断。

做法：

- 使用场景自然一点，不要一上来就硬卖。
- 优点要具体，适合人群要说清楚。
- 如果有缺点或限制，读得平稳可信。
- 购买建议放在结尾，语气要像建议，不要强迫。

示例：

```xml
<speak rate="0.98" pitch="1.0" volume="62">我用了两周，最明显的感受是它不厚重，早上赶时间也能很快推开。</speak><speak rate="0.94" pitch="0.98" volume="60">但如果你是特别干的皮肤，<break time="250ms"/>建议先做好保湿。</speak><speak rate="1.04" pitch="1.04" volume="68">想要通勤妆自然一点的，可以重点看这款。</speak>
```

### 直播切片和限时转化

目标：把限时信息、利益点和行动指令读清楚。

做法：

- 开头直接提醒正在发生什么。
- 价格、库存、限时条件用短停顿隔开。
- 行动指令清楚，避免太长。
- 不要为了紧迫感把全文读得过快。

示例：

```xml
<speak rate="1.08" pitch="1.06" volume="72">这一轮福利先提醒一下，<break time="300ms"/>库存不多。</speak><speak rate="0.96" pitch="1.0" volume="66">需要的朋友先领券，再下单，价格会更合适。</speak>
```

### 产品功能讲解

目标：把功能、步骤和适合人群讲明白，适合做教程型带货或产品介绍。

做法：

- 功能名和步骤名前后加短停顿。
- 数字、型号、规格要用 `say-as` 或 `sub` 修正。
- 每个 segment 只讲一组功能或一个步骤。
- 结尾用一句话总结适合谁。

示例：

```xml
<speak rate="0.96" pitch="1.0" volume="64">它有三个常用档位：<break time="250ms"/>日常清洁、强力去污、还有快速除味。</speak><speak rate="0.94" pitch="0.99" volume="62">如果你主要用在厨房，直接选强力去污这一档就够了。</speak>
```

## 常见错误和修正

- 错误：用 `<prosody>` 控制单句。
  修正：用 `<speak rate="..." pitch="..." volume="...">`，必要时拆成多个并列 `<speak>`。

- 错误：写 `<prosody rate="0.9" volume="medium">`。
  修正：`<speak rate="0.9" volume="60">...</speak>`。

- 错误：写 `<speak rate="0.82" pitch="-2" volume="50">`。
  修正：CosyVoice 的 `pitch` 是正数倍率，低沉或稳重口播可写 `<speak rate="0.9" pitch="0.94" volume="58">`。

- 错误：把“温柔地说”“停顿一下”写进要朗读的文本。
  修正：把风格放进 `prompt`，把停顿写成 `<break/>`。

- 错误：每句话都独立 `<speak>`。
  修正：只有明显语气区块变化才拆 `<speak>`。

- 错误：所有句号后都加 `<break time="700ms"/>`。
  修正：只在重点、转折、段落、结尾加显式停顿。

- 错误：为了表达情绪使用 `emotion:"happy"`。
  修正：CosyVoice 不用 emotion，用 `prompt`、`<speak>` 属性、标点和 `<break/>` 表达。

- 错误：用 MiniMax `<#0.6#>`。
  修正：改成 `<break time="600ms"/>`。

## 自检清单

调用 `voice.speech` 前，必须检查：

- 当前模型确实是 CosyVoice 系列。
- 短文本用 `input`，长文本用 `segments`。两者都必须是最终可执行内容，不是分析文本。
- 每个 SSML 片段都包在 `<speak>` 内，且没有嵌套 `<speak>`。
- 每个 `<speak>` 都显式包含数字形式的 `rate`、`pitch`、`volume`。
- 每个 `rate` 和 `pitch` 都在 `0.5-2` 之间；没有 `pitch="-2"`、`pitch="-1"`、`pitch="0"` 这类 MiniMax pitch。
- 每个 `volume` 都在 `0-100` 之间；没有 `volume="0.8"`、`volume="1.0"` 这类小数音量。
- 多句/长文本/带货口播/自媒体口播/产品讲解不只是添加 `<break/>`，而是有按语气区块变化的 `<speak>` 参数。
- 长文本已拆成多个 `segments`，每个 segment 都有自己的 `prompt`；短文本可以只有全局 `prompt`。
- 没有 `<prosody>`、`emotion`、MiniMax 停顿标记。
- 用户原文没有被无故改写。
- 长文本有清晰口播结构，而不是全篇同一速度同一停顿。
- 需要强调、转折、结尾的地方有合理停顿。
- 容易读错的数字、日期、电话、ID、多音字已经用 `say-as`、`phoneme` 或 `sub` 修正。
- `prompt` 是声音风格，不包含逐句分析、分镜或说明。
- `waitForCompletion` 为 `true`，除非用户明确只要提交异步任务。
