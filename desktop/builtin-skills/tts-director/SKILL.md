---
name: tts-director
description: Use when generating expressive TTS, long-form narration, poetry reading, audiobooks, ads, character speech, podcast-style voiceover, or any speech request that needs emotion, tone, speed, pitch, rhythm, pauses, or multi-segment delivery. Convert the final script into a single voice.speech payload with intentional MiniMax controls and ordered segments; do not call TTS repeatedly or hand-merge audio.
allowedRuntimeModes: [chatroom, redclaw]
allowedTools: [workflow]
activationScope: turn
autoActivate: false
activationHint: 当用户要生成朗读、口播、诗词朗诵、有感情配音、长文本语音、多情绪语音、广告旁白、有节奏的 TTS，或明确要求语气/情绪/语速/停顿时，可调用 `Operate(resource="skills", operation="invoke", input={ "name": "tts-director" })`。本技能负责把最终台词优化成一次 `voice.speech` 请求的 `segments`，再由媒体队列合并最终音频。
contextNote: 这是 TTS 表演设计技能。它不负责重写文章主题，不负责视频画面设计；它只把已确认或可直接朗读的文本转成有节奏、有情绪层次、可执行的 MiniMax TTS payload。
hookMode: inline
---

# TTS Director

Use this skill before calling `Operate(resource="voice", operation="speech", input={ ... })` when the speech should sound performed rather than flat.

## Core Mission

Turn the final spoken script into one executable TTS request:

- Preserve the user's words unless they asked for rewriting.
- Split the script into meaningful performance beats.
- Assign each beat `emotion`, `speed`, `pitch`, intentional punctuation, and pause markers.
- Submit one `voice.speech` call with ordered `segments` for multi-beat delivery.
- Let the media runtime merge the final audio. Do not synthesize each segment manually.

## When To Use

Use this skill for:

- long narration, audiobook, podcast, documentary, explainer, or course voiceover
- poetry, prose, dramatic reading, storytelling, character lines, or dialogue
- ads, livestream welcome, product pitch, trailer voiceover, or emotional CTA
- any request that says 有感情、带情绪、有节奏、自然一点、像真人读、分段语气、慢一点、激昂一点
- any script where different paragraphs clearly need different emotional energy

Skip this skill for a tiny neutral sentence unless the user asks for tone control.

## Output Contract

The final action must be exactly one `voice.speech` request.

Use plain `input` only when the text is short and has one stable mood. Use `segments` when there are multiple beats, paragraph changes, emotional shifts, dialogue turns, or long-form reading.

Required payload shape for multi-beat speech:

```json
{
  "voiceId": "voice_xxx",
  "segments": [
    {
      "input": "第一段朗读文本。<#0.5#>",
      "emotion": "calm",
      "speed": 0.94,
      "pitch": 0
    },
    {
      "input": "第二段朗读文本。",
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

## Performance Mapping

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

Use pauses as performance punctuation:

- `<#0.25#>` for a small beat inside a sentence.
- `<#0.4#>` or `<#0.5#>` after an image, contrast, or clause that should land.
- `<#0.7#>` or `<#0.9#>` before a major turn, refrain, punchline, or emotional drop.
- Avoid adding a pause after every punctuation mark.
- Do not exceed roughly 2-3 explicit pauses per short segment unless the form is poetry or dramatic reading.

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
- Multi-beat speech uses one `segments` array, not repeated tool calls.
- Each segment has a reason for its emotion, speed, punctuation, and pauses.
- The first and last segments are not accidentally identical in energy when the script has an arc.
- Expressive punctuation is intentional; there is no accidental blanket `！！` / `～～` / `……` across the whole script.
- `waitForCompletion` is true when the user expects the finished audio now.
