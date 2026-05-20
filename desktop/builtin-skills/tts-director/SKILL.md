---
name: tts-director
description: Use when generating expressive TTS, short-video voiceover, self-media narration, product explanation, ads, livestream clips, character speech, podcast-style voiceover, or any speech request that needs tone, speed, pitch, rhythm, pauses, or multi-segment delivery. For ordinary chat/audio work this skill is the TTS entrypoint. CosyVoice SSML is not a general entrypoint: only activate `cosyvoice-ssml` inside a video-director managed digital-human / VideoRetalk / asset-library talking-head video flow. MiniMax uses ordered segments with emotion controls. Do not call TTS repeatedly or hand-merge audio.
allowedRuntimeModes: [chatroom, redclaw, image-generation, audio-editor]
allowedTools: [workflow]
activationScope: turn
autoActivate: false
activationHint: 当用户要生成短视频口播、自媒体口播、带货口播、产品讲解、种草测评、直播切片、朗读、有节奏的 TTS，或明确要求语气/情绪/语速/停顿时，可调用 `Operate(resource="skills", operation="invoke", input={ "name": "tts-director" })`。如果用户要的是视频或口播视频，必须先调用 `video-director`，不要用本技能直接接管视频任务。只有在 `video-director` 已确认这是数字人 / VideoRetalk / 资产库角色 talking-head 视频，并进入 TTS 子步骤时，CosyVoice 分支才允许激活 `cosyvoice-ssml`；普通聊天、普通音频和普通视频请求不得激活 `cosyvoice-ssml`。
contextNote: 这是 TTS 表演设计技能。它不负责重写文章主题，不负责视频画面设计；它只把已确认或可直接朗读的文本转成有节奏、有情绪层次、可执行的模型专用 TTS payload。视频任务入口始终是 `video-director`。`cosyvoice-ssml` 只属于数字人 / VideoRetalk / 资产库角色口播视频的内部 TTS 子流程；MiniMax 不使用 prompt/SSML。
maxPromptChars: 18000
hookMode: inline
---

# TTS Director

Use this skill before calling `Operate(resource="voice", operation="speech", input={ ... })` when the speech should sound performed rather than flat.

## Core Mission

Turn the final spoken script into one executable TTS request:

- Preserve the user's words unless they asked for rewriting.
- For dialogue or role audio, first identify the speaker/role count and choose a distinct `voiceId` for each role before segmenting. Use `availableVoicesForAgent` from the generation context when present; call `voice.list` if the context does not provide enough voices.
- Identify the selected TTS model before designing controls. Use `model` from the request/context when present.
- For CosyVoice-family models such as `cosyvoice-v3.5-plus`, only invoke `cosyvoice-ssml` when the current task is already a `video-director` managed digital-human / VideoRetalk / asset-library talking-head video and the TTS is the approved character speech track. Outside that narrow flow, do not activate `cosyvoice-ssml`.
- For MiniMax-family models such as `speech-2.8-turbo`, split the script into meaningful performance beats and speaker turns, then assign each beat `emotion`, `speed`, `pitch`, punctuation, and pause markers.
- Submit one `voice.speech` call. Do not synthesize each segment manually.
- In the final user-facing response, present the merged `finalAudio` only. Do not list segment files as the result.

## Model Branching

Before creating the final payload, classify the TTS model:

- CosyVoice branch: model name contains `cosyvoice`, especially `cosyvoice-v3.5-plus`; this branch may use `cosyvoice-ssml` only inside a digital-human / VideoRetalk video flow already owned by `video-director`.
- MiniMax branch: model name starts with `speech-` or contains `minimax`.
- Unknown model: keep controls conservative; prefer plain `input` plus `prompt` only if the provider is known to accept it.

This distinction is mandatory because the models support different controls:

- CosyVoice supports `prompt` and a limited SSML tag set. It does not support the MiniMax `emotion` field.
- MiniMax supports `emotion`, `speed`, `pitch`, MiniMax pause markers, and `segments`. It does not support CosyVoice `prompt`.
- The `segments` array is a media-runtime sequence feature, not a MiniMax-only capability. MiniMax uses it for emotion/speed/pitch segment controls. CosyVoice SSML segments are reserved for the digital-human / VideoRetalk flow.

If the selected model is CosyVoice and the task is not a `video-director` digital-human / VideoRetalk TTS substep, do not invoke `cosyvoice-ssml`. Keep the TTS payload conservative, or ask the user to move into the数字人 workflow if they need a character talking-head video. If the selected model is CosyVoice inside the approved digital-human flow, invoke `cosyvoice-ssml` once before building the final request. `skills.invoke` only activates instructions; it does not return SSML.

If the selected model is MiniMax, do not output SSML or `prompt`. Use the existing `segments` workflow.

## When To Use

Use this skill for:

- short-video narration, self-media口播, product explanation, product seeding, review, livestream clip, or course voiceover
- ads, livestream welcome, product pitch, trailer voiceover, or CTA
- character lines, dialogue, or podcast-style voiceover
- any request that says 有感情、带情绪、有节奏、自然一点、像真人读、分段语气、慢一点、激昂一点
- any script where different paragraphs clearly need different emotional energy

Skip this skill for a tiny neutral sentence unless the user asks for tone control.

## Output Contract

The final action must be exactly one `voice.speech` request.

Choose the payload shape from the selected TTS model.

### CosyVoice Payload

For `cosyvoice-v3.5-plus`, activate `cosyvoice-ssml` before constructing SSML only when this TTS request is part of a `video-director` managed digital-human / VideoRetalk / asset-library talking-head video:

```json
{
  "resource": "skills",
  "operation": "invoke",
  "input": { "name": "cosyvoice-ssml" }
}
```

Then submit the single `voice.speech` request you build from the activated skill rules. Use one request only; for long text, put multiple items in `segments` and let the media runtime merge them.

Short-text payload shape:

```json
{
  "model": "cosyvoice-v3.5-plus",
  "voiceId": "voice_xxx",
  "input": "<speak rate=\"0.9\" pitch=\"0.95\" volume=\"60\">完整 SSML 文本</speak>",
  "prompt": "整体朗读风格提示，例如：温柔、平稳、有耐心。",
  "language_hints": ["zh"],
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

Long-text payload shape:

```json
{
  "model": "cosyvoice-v3.5-plus",
  "voiceId": "voice_xxx",
  "segments": [
    {
      "input": "<speak rate=\"0.86\" pitch=\"0.94\" volume=\"54\">第一段 SSML。</speak>",
      "prompt": "平稳、克制、有画面感。",
      "pauseAfterSeconds": 0.4
    },
    {
      "input": "<speak rate=\"0.76\" pitch=\"0.86\" volume=\"46\">第二段 SSML。</speak>",
      "prompt": "悲伤、压低、声音更轻。",
      "pauseAfterSeconds": 0.8
    }
  ],
  "language_hints": ["zh"],
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

CosyVoice SSML construction rules live in `cosyvoice-ssml`, but that skill is reserved for digital-human / VideoRetalk video speech tracks. The short version for that narrow flow:

- Use only CosyVoice-supported tags: `<speak>`, `<break/>`, `<sub>`, `<phoneme>`, `<soundEvent/>`, `<say-as>`.
- Do not use `<prosody>`; CosyVoice rate, pitch, and volume are `<speak>` attributes.
- CosyVoice `pitch` is a positive `0.5-2` multiplier. Never copy MiniMax pitch values such as `-2`, `-1`, or `0` into CosyVoice SSML. Use values such as `0.86-0.96` for low/sad delivery, `0.96-1.04` for natural narration, and `1.04-1.16` for brighter delivery.
- CosyVoice `rate` is a positive `0.5-2` multiplier. Use values such as `0.76-0.92` for slow delivery, `0.92-1.04` for natural narration, and `1.04-1.16` for lively delivery.
- CosyVoice `volume` is a `0-100` scale, not `0-1`. Use values such as `50-65` for normal narration and `38-52` for quiet narration; never use `volume="0.8"` or `volume="1.0"`.
- Keep user wording intact inside text nodes unless rewriting was requested.
- Add `prompt` for voice style. For a single `input`, keep it global; for `segments`, write one concise prompt per segment.
- Multi-sentence digital-human / VideoRetalk speech tracks should use `segments`, not one giant SSML document.
- Use `language_hints`, for example `["zh"]`, when the script is mostly Chinese.

CosyVoice example:

```json
{
  "model": "cosyvoice-v3.5-plus",
  "voiceId": "voice_xxx",
  "input": "<speak rate=\"0.9\" pitch=\"0.95\" volume=\"60\">今天，我们慢一点开始。<break time=\"500ms\"/>接下来，请注意这个重点。</speak>",
  "prompt": "请用温柔、平稳、有耐心的口播语气朗读。",
  "language_hints": ["zh"],
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

### MiniMax Payload

Use plain `input` only when the text is short and has one stable mood. Use `segments` when there are multiple beats, paragraph changes, emotional shifts, dialogue turns, or long-form reading.

Required payload shape for multi-beat speech:

```json
{
  "voiceId": "voice_xxx",
  "segments": [
    {
      "input": "第一段朗读文本。<#0.5#>",
      "voiceId": "voice_xxx",
      "emotion": "calm",
      "speed": 0.94,
      "pitch": 0,
      "pauseAfterSeconds": 0.4
    },
    {
      "input": "第二段朗读文本。",
      "voiceId": "voice_yyy",
      "emotion": "happy",
      "speed": 1.06,
      "pitch": 1
    }
  ],
  "title": "可读标题",
  "responseFormat": "mp3",
  "waitForCompletion": true
}
```

Do not put control instructions in the spoken text. The text may contain expressive punctuation, MiniMax markers such as `<#0.6#>`, `(laughs)`, `(sighs)`, or `(breath)` only when they should be performed.

For multi-role audio, each segment may override parent `voiceId`. Use one segment per speaker turn when the voice changes.

## Performance Mapping

This mapping is for MiniMax `emotion` values. For CosyVoice, invoke `cosyvoice-ssml` only in the digital-human / VideoRetalk subflow; that skill translates delivery intent into CosyVoice-supported SSML rather than the `emotion` field.

Do not reuse the MiniMax pitch numbers below in CosyVoice. MiniMax `pitch:-2..3` is a segment control scale; CosyVoice `<speak pitch>` is a positive multiplier in `0.5-2`.

Choose controls from the text's rhetorical function, not from paragraph length.

- Calm setup / explanation: `emotion:"calm"`, `speed:0.92-1.02`, `pitch:0`
- Smooth narration / connective lines: `emotion:"fluent"`, `speed:0.98-1.06`, `pitch:0`
- Joy, invitation, light humor: `emotion:"happy"`, `speed:1.04-1.14`, `pitch:0..2`
- Surprise or reveal: `emotion:"surprised"`, `speed:0.96-1.08`, `pitch:1..3`
- Sorrow, nostalgia, regret: `emotion:"sad"`, `speed:0.82-0.95`, `pitch:-2..0`
- Anger, urgency, challenge: `emotion:"angry"`, `speed:1.02-1.16`, `pitch:0..2`
- Fear, suspense, uncertainty: `emotion:"fearful"`, `speed:0.86-1.0`, `pitch:-1..1`
- Whispered aside: pass `emotion:"whisper"` or `emotion:"whipser"` only when the script explicitly calls for whispering.

Avoid flat defaults. A long expressive reading should not become many segments that all use `fluent`, `speed:1.0`, and no pauses.

## Rhythm Rules

For CosyVoice inside a digital-human / VideoRetalk subflow, invoke `cosyvoice-ssml`, split long text into ordered SSML segments, and use CosyVoice-supported `<break time="...ms"/>`, `<speak>` attributes, `<sub>`, `<phoneme>`, `<soundEvent/>`, and `<say-as>`. For MiniMax, use `<#0.4#>` markers and segment boundary pauses as described below.

Use pauses as performance punctuation:

- `<#0.25#>` for a small beat inside a sentence.
- `<#0.4#>` or `<#0.5#>` after an image, contrast, or clause that should land.
- `<#0.7#>` or `<#0.9#>` before a major turn, refrain, punchline, or emotional drop.
- Avoid adding a pause after every punctuation mark.
- Do not exceed roughly 2-3 explicit pauses per short segment unless the form is poetry or dramatic reading.

Use structured boundary pauses for silence between generated clips:

- Use inline `<#0.4#>` markers inside `input` when the pause belongs to the spoken performance of that line.
- Use `pauseAfterSeconds` on a segment when the silence belongs between two turns, speakers, scenes, or paragraphs.
- Use `pauseBeforeSeconds` only when a segment needs a leading beat before the speaker starts.
- For dialogue, prefer `pauseAfterSeconds: 0.2-0.5` after normal turns, `0.6-0.9` before emotional turns, and `1.0-1.5` for scene breaks.
- Do not create fake empty TTS segments just to add silence. The media runtime inserts silence during final merge from `pauseBeforeSeconds` / `pauseAfterSeconds`.

Recommended workflow for complex or multi-speaker audio:

1. Determine the selected TTS model and role count.
2. Select one distinct `voiceId` per role from available voices when multi-role audio is requested. Do not claim only one voice can be used unless `voice.list` confirms no alternative voice exists.
3. If using CosyVoice inside a digital-human / VideoRetalk subflow, invoke `cosyvoice-ssml` and build ordered SSML segments. Each segment must include final spoken text, a complete `<speak rate pitch volume>` SSML input, a segment-specific `prompt`, and boundary pause fields when needed. If multiple voices are required, put the chosen `voiceId` on each segment when available.
4. If using MiniMax, build ordered speaker-turn segments. Each segment must include final spoken text, the role's `voiceId`, punctuation, `emotion`, `speed`, optional `pitch`, and boundary pause fields.
5. Submit exactly one `voice.speech` request with `waitForCompletion:true`.

When the tool returns, use `finalAudio.previewUrl` or `finalAudio.path` as the playable result in the conversation. Segment files are intermediate implementation details and should not be shown as the main deliverable.

## Punctuation As Delivery Control

TTS models are sensitive to punctuation. Use punctuation as part of the performance design, not just grammar.

You may adjust punctuation when it improves delivery, but preserve the user's wording and meaning. Do not over-decorate formal, factual, or classical text unless the desired reading is explicitly dramatic.

Common punctuation effects:

- `，` keeps a phrase flowing with a light breath.
- `。` closes a thought with a firmer landing.
- `、` creates a quick list rhythm.
- `？` raises uncertainty, challenge, invitation, or rhetorical tension.
- `！` adds force, excitement, command, surprise, or emotional release.
- `……` creates hesitation, trailing thought, suspense, grief, softness, or a held emotional beat.
- `～` softens, lengthens, teases, coaxes, or makes speech more playful and intimate.
- `：` sets up a reveal, quote, or list.
- `——` creates an inserted turn, interruption, dramatic shift, or held emphasis.
- `？！` combines shock and questioning; use sparingly.
- `！！` or `！！！` can intensify excitement or urgency, but should be rare and never used as a default.
- `？？` can express disbelief or playful challenge; avoid in serious narration unless intentional.

Examples:

- Warm invitation: `来，先听我说～<#0.4#>`
- Surprise reveal: `你以为结束了吗？<#0.3#>还没有！`
- Emotional hesitation: `我以为……<#0.5#>我真的以为不会再见到你。`
- Energetic CTA: `现在就开始！！<#0.3#>`
- Classical recitation should usually stay cleaner: prefer `。<#0.7#>` or `，<#0.4#>` over casual `～` unless the user wants modern expressive朗读.

When choosing between punctuation and MiniMax pause tags:

- Use punctuation to shape tone inside the spoken text.
- Use `<#0.4#>` style markers for exact timing.
- Combine them only when the emotional beat needs both tone and duration, for example `真的值得吗？<#0.6#>`.

Segment size guidance:

- For narration: usually 1-3 sentences per segment.
- For poetry: split by couplet, refrain, or emotional turn.
- For ads and口播: split by hook, value, proof, offer, CTA.
- For dialogue: split by speaker and intention.

## Poetry And Classical Text

For poetry, design a rising and falling arc.

- Opening image: slower, calm or fluent, with a landing pause.
- Philosophical turn: slower, calm or sad if reflective.
- Refrain or invitation: stronger pace, fluent or happy/surprised, with clearer pauses.
- Climax: faster or more forceful, often happy, surprised, or angry depending on text.
- Ending release: slow down slightly and leave a final pause.

Keep the original text intact. Insert only pause markers that improve recitation.

## Self Check Before TTS

Before calling `voice.speech`, verify:

- The payload contains the final spoken words, not analysis or instructions.
- The model branch is correct:
  - CosyVoice digital-human / VideoRetalk only: `cosyvoice-ssml` was invoked; only extremely short neutral text may use one SSML `input`; multi-sentence expressive text uses `segments`, each with SSML `input` and segment `prompt`; no `emotion`.
  - MiniMax: `segments` allowed, `emotion` allowed, no SSML, no `prompt`.
- For CosyVoice digital-human / VideoRetalk speech tracks, every segment has a chosen tone and that tone is reflected with both CosyVoice-supported SSML and segment `prompt`.
- For MiniMax, multi-beat speech uses one `segments` array, not repeated tool calls.
- Each segment or SSML sentence has a reason for its emotion/tone, speed/rate, punctuation, and pauses.
- The first and last segments are not accidentally identical in energy when the script has an arc.
- Expressive punctuation is intentional; there is no accidental blanket `！！` / `～～` / `……` across the whole script.
- `waitForCompletion` is true when the user expects the finished audio now.
