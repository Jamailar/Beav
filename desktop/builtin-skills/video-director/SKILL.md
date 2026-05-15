---
name: video-director
description: Use when the user asks for a promotional film, ad film, short video, product video, reference-image video, image-to-video, first/last-frame transition, storyboard/keyframes, or character talking-head video. This includes Chinese requests such as 宣传片, 广告片, 短片, 短视频, 视频, 分镜, 分镜图, 参考图生成视频, 图片转视频, 包包/商品/产品宣传片. Produces a detailed script and shot table first, then generates storyboard contact-sheet preview images through image.generate using four/six/nine-panel grids, includes any product or visual reference images, asks the user to confirm, and only then calls the correct video model. For asset-library character talking-head / 口播 videos, it must synthesize the approved spoken script with the character voice through TTS before calling video generation.
allowedRuntimeModes: [chatroom, redclaw]
allowedTools: [workflow]
activationScope: session
activationHint: Invoke this before any media generation when the user asks for 宣传片, 广告片, 短片, 短视频, 视频, 分镜, 分镜图, 图片转视频, reference-image video, product promotional video, or an attached/reference image to become a video. Do not call image.generate or video.generate first; load this skill and follow its staged workflow.
---

# Video Director

Use this skill before calling `Operate(resource="video", operation="generate", input={ ... })` for video work.

If this skill was loaded because the user attached an image and asked for a promotional film / 宣传片 / 视频, treat the attached image as a product or visual reference for the video workflow. Do not generate a replacement product image as an "analysis" step.

## Default Workflow

Before any video tool call, follow this order:

1. Clarify the intended video mode from the user's goal and assets.
2. Draft a concise but detailed video script and shot table for review.
3. Generate storyboard contact-sheet preview image(s) with `Operate(resource="image", operation="generate", input={ ... })`. The storyboard image is a preview of the planned shots, not a standalone product poster, replacement product render, cover image, or final video keyframe.
4. Show the script, storyboard preview image(s), and explicit video specs together.
5. Ask for confirmation or revision.
6. Default to direct video generation after confirmation.
7. Only use a video project pack if the user explicitly asks for a project/package/editor workflow, or the task is already bound to an existing pack.
8. Decide whether this should be a single-video job or a multi-video assembly.
9. If the confirmed task is a character talking-head / 口播 video, complete the TTS-first workflow below.
10. Only after confirmation and any required TTS audio is complete, call `Operate(resource="video", operation="generate", input={ ... })`.

If the user has not yet confirmed the script, do not generate the video.

If the user has not yet seen and approved the storyboard preview image(s), do not generate the video.

The storyboard contact-sheet preview is mandatory after the first shot script is written. It is not the same as final video keyframes; it is a quick visual proof of the planned shot sequence so the user can approve direction, composition, product placement, and continuity before video generation.

For product promotional videos from an attached/reference image:

- The first `image.generate` call, if any, must be for a storyboard contact sheet after the script and shot table exist.
- The storyboard prompt must explicitly say it is a multi-panel storyboard preview for the video, and it must preserve the attached/reference product's visible shape, material, color, and distinctive details.
- Do not call `image.generate` just to "analyze", "extract", "enhance", or recreate the product reference.
- Do not call `video.generate` until the user confirms the storyboard direction.

## Asset-Library Character Talking-Head Rule

When the user wants a talking-head / 口播 / presenter / livestream welcome video using a character from the asset library, the character image is only the visual identity reference. It is not the speech track.

Keep these three inputs separate:

- `voiceId`: the reusable cloned voice identity stored on the character asset. This is the primary voice field for future TTS calls.
- voice sample / reference audio: fallback source material for cloning when no ready `voiceId` exists. Do not keep analyzing or presenting it once a ready `voiceId` has been found.
- generated TTS audio asset: the completed spoken script. This is the only audio that should drive a character talking-head video.

Use this exact order:

1. **Script and storyboard first**
   - Confirm the final spoken script.
   - Confirm the storyboard / shot table.
   - The `Sound` column must contain the actual spoken lines, not vague labels like “角色讲解”.
2. **Resolve the character voice**
   - Read the selected character asset before generating media.
   - If the asset has a ready `voiceId` / `voice_id`, treat that as the resolved voice and stop inspecting voice samples. Report the resolved `voiceId`, not the reference-audio filename.
   - If the asset has a voice sample but no ready `voiceId`, call `Operate(resource="voice", operation="clone", input={ ... })` first, wait for completion, and use the returned `voiceId`.
   - If there is no ready `voiceId` and no usable voice sample, stop and ask the user to provide or choose a voice. Do not fall back to a generic voice silently.
3. **Generate the complete voice track with TTS**
   - Call `Operate(resource="voice", operation="speech", input={ ... })` with the full approved spoken script and the resolved `voiceId`.
   - Prefer one complete audio asset for the whole talking-head segment unless the user explicitly wants separate clips.
   - For expressive narration, long scripts, poetry, ads, or any multi-emotion performance, activate `tts-director` first with `Operate(resource="skills", operation="invoke", input={ "name": "tts-director" })`, then use its guidance to split the approved script into semantic beats and assign intentional `emotion`, `speed`, `pitch`, punctuation, and pauses.
   - Add restrained delivery controls when they improve the approved performance: use `speed` for pace, `pitch` for tone, `emotion` for mood, expressive punctuation such as `～`, `？`, `！`, `……`, and MiniMax text markers such as `<#0.6#>`, `(laughs)`, `(sighs)`, or `(breath)` inside `input` only where the spoken rhythm needs them.
   - Do not write control instructions into the spoken text. For example, pass `"emotion":"happy"` and `speed:1.08` instead of making the character say “用开心快速的语气”.
   - If the approved voice track needs multiple emotional beats, submit one `voice.speech` call with ordered `segments`; the media runtime will generate each segment and merge the final audio. Do not make repeated `voice.speech` calls and then manually merge.
   - Wait until the TTS result contains a usable audio asset path, URL, or asset id.
   - Do not start video generation while the TTS job is only queued or running.
4. **Generate video with visual reference plus generated audio**
   - Use the selected character image as the visual reference.
   - Use the newly generated complete TTS audio asset as `drivingAudio`.
   - Identify it in the prompt preface as generated speech audio, for example `Audio 1: generated Jamba TTS speech for lip-sync / speaking rhythm`.
   - Then call `Operate(resource="video", operation="generate", input={ ... })`, normally in `reference-guided` mode.

This is mandatory because the video model needs a finished audio waveform aligned with the approved script. A character `voiceId` is not audio. A voice sample is not the approved spoken line. The spoken text inside the video prompt is not a substitute for TTS.

Forbidden shortcuts:

- Do not call video generation for character口播 with only the character image and a script.
- Do not pass `voiceId`, voice sample audio, or “音色素材” as `drivingAudio`.
- Do not rely on `generateAudio` to create the character voice for talking-head work.
- Do not describe the intended speech only in the video prompt and expect the video model to synthesize it.
- Do not split the TTS per storyboard row unless the user asks for separately editable audio clips or the video will be assembled from multiple independent speaking clips.

Recommended TTS payload shape:

```json
{
  "voiceId": "voice_xxx",
  "segments": [
    {
      "input": "完整、已确认的口播开场。<#0.5#>",
      "speed": 0.98,
      "pitch": 0,
      "emotion": "calm"
    },
    {
      "input": "自然地进入更有感染力的重点(laughs)。",
      "speed": 1.05,
      "pitch": 0,
      "emotion": "happy"
    }
  ],
  "title": "Jamba welcome voiceover",
  "waitForCompletion": true
}
```

Recommended video payload shape after TTS completes:

```json
{
  "generationMode": "reference-guided",
  "referenceImages": ["/absolute/path/to/jamba.png"],
  "drivingAudio": "/absolute/path/to/generated-jamba-tts.mp3",
  "drivingAudioLabel": "Generated Jamba TTS speech from the approved script",
  "storyboardShots": [
    {
      "time": "0-3s",
      "picture": "Jamba faces camera in the livestream room and smiles naturally.",
      "sound": "欢迎来到直播间，今天给大家准备了一个超实用的好物。",
      "shot": "Medium close-up, stable presenter framing."
    }
  ]
}
```

## Video Project Pack Rule

A video project pack is not the default path.

Create one only when:

- the user explicitly asks for a 视频项目 / 视频工程 / 项目包
- the user explicitly asks to continue later inside the video editor / project workbench
- the task is already bound to an existing video project pack

Do not create one only because the request has multiple shots, long context, continuity risk, storyboard needs, or possible revisions.

When it is explicitly needed, create it with:

- `Operate(resource="video", operation="create", input={ "explicitProjectWorkflow": true, "title": "...", "duration": "...", "aspectRatio": "...", "mode": "..." })`

The project folder lives in:

- `manuscripts/video/<project-name>/`

It should be used to keep these files together:

- `manifest.json`
- `script.md`
- `assets.json`
- `editor.project.json`
- imported reference images / keyframes / generated clips / final output

After the pack is created:

- write the user brief and approved script back into the video project folder
- keep later keyframes, clips, and outputs in the same pack whenever possible

Otherwise keep the planning in chat, call `video generate` directly, and let the output live in the generated media library.

## Hard Rules

- Video generation is locked to the official video route configured by the app.
- Do not choose arbitrary video endpoints or third-party video models.
- Use only these official model mappings:
  - `text-to-video` -> `wan2.7-t2v-video`
  - `reference-guided` -> `wan2.7-r2v-video`
  - `first-last-frame` -> `wan2.7-i2v-video`
- Treat first/last-frame transitions as a subtype of image-to-video work.
- Do not skip the script review step just because the request sounds obvious.
- Unless the user explicitly asks for a longer continuous shot, a single shot should usually be `1-3` seconds.
- Without explicit user approval, any single shot must not exceed `5` seconds.

## Mode Selection

- Use `text-to-video` when the user only provides text and wants a fresh video shot.
- Use `reference-guided` when the user provides one or more reference images and wants the video to absorb subject elements, style cues, props, scene motifs, or composition hints from those images.
- Use `first-last-frame` only when two images have explicit start/end semantics, such as “from A to B”, “首帧/尾帧”, “开头/结尾”, or “起始状态/结束状态”.
- If the user gives two images but they are only style references, do not use `first-last-frame`; stay with `reference-guided` semantics instead.

## Production Strategy

- `单视频模式`:
  - Use one generated video clip.
  - Default when the request is simple, the action is short, and the full idea fits inside one coherent clip.
  - A single generated clip must not exceed `15` seconds.

- `多视频模式`:
  - Use multiple clips when the request contains many beats, scene changes, multiple camera setups, or a narrative that would be unstable as one long clip.
  - Generate the required clips one by one, then combine them with `ffmpeg` through the available tool path.
  - When planning multi-video mode, group the storyboard into separate clip units first, then specify the final concatenation order.

- If the request has multiple shots, clear continuity requirements, or a risk of visual drift, ask one more question after showing the contact-sheet preview:
  - whether separate storyboard keyframes should also be generated before video production.
- If separate storyboard keyframes are generated, later video generation should preferentially use image-based modes, and for transition-heavy segments should prefer `first-last-frame`.

## Storyboard-First Rule

Every video task needs a storyboard contact-sheet preview after the script table and before user confirmation.

Use generated individual keyframes in addition to the contact sheet when the request is complex enough that video quality depends on stable keyframes.

Use storyboard-first when one or more of these is true:

- There are many shots or visual beats.
- Character identity must remain highly stable.
- Environment continuity matters.
- The user wants a sequence that later becomes one assembled video.
- The user explicitly asks for storyboard frames / keyframes / 分镜图.

When any of the above is true, do not silently continue to video generation after the contact sheet. Ask the user whether they also want separate image-generated storyboard keyframes before video generation.

When storyboard-first is used, follow this exact process:

1. First design a **core environment reference image**.
2. Generate that image first.
3. Then generate later keyframes one by one.
4. Each later keyframe must use the core environment reference image as a reference image.
5. If a character asset already exists in the asset library, the asset reference and the core environment reference should both be preserved across later keyframes.
6. Only after the keyframes are stable should video generation proceed.

## Core Environment Reference Image

The first storyboard image should be a single **overall environment master frame**.

It must contain:

- the full spatial layout,
- the key environment elements,
- the main subject placement,
- the major props,
- the lighting logic,
- the camera worldview for the sequence.

This image acts as the environmental anchor for all later keyframes.

Do not start by generating an isolated close-up if the later sequence depends on environment continuity.

## Storyboard Contact-Sheet Preview

After writing the script table, generate the required storyboard effect image(s) before asking for final video approval.

Use the shot count to choose the grid:

- `1-4` shots -> four-panel grid.
- `5-6` shots -> six-panel grid.
- `7-9` shots -> nine-panel grid.
- More than `9` shots -> split into multiple contact sheets; each generated image contains at most `9` storyboard panels.

Rules:

- One generated image may contain at most `9` storyboard panels.
- A storyboard contact sheet is a single output image. Set `count: 1` and put every panel description inside `prompt`.
- Do not use `imagePlanItems` for storyboard contact sheets; `imagePlanItems` means separate image outputs unless the tool contract explicitly says otherwise.
- Do not add extra invented shots to fill empty panels.
- Keep the panel order left-to-right, top-to-bottom, matching the script table.
- The preview should show composition, subject placement, camera scale, product/prop position, action beat, lighting, and style continuity.
- Do not render planning labels, shot numbers, table headers, or internal notes inside the image unless the user explicitly asks for visible text.
- The contact sheet is for visual approval only; it does not replace the approved Markdown script or `storyboardShots` payload used later for video generation.

Reference handling is mandatory:

- Before any `image.generate` or `video.generate` call that depends on prior context, inspect the Current session resources block. If the needed file is not obvious there, call `Operate(resource="session", operation="list", input={ "kind": "image", "limit": 20 })` or `Operate(action="session.resources.list", payload={...})` and use the returned `reference` / `path` value exactly.
- If the user attached or selected product images, character images, brand images, scene references, or previous generated images, pass them to `image.generate` as `referenceImages`.
- If the reference comes from the asset library, read the asset first and pass its resolved image path(s) through `referenceImages` or `subjectIds`.
- If several references exist, include prompt preface lines that define each role, such as `Image 1: product shape and material reference`, `Image 2: character identity reference`, `Image 3: scene mood reference`.
- Do not describe reference images only in prose while leaving them out of the tool input.
- Do not invent local paths, filenames, or user folders. Use only user-provided paths, asset-library paths, or `session.resources.*` results.
- If there are more reference images than the tool supports, prioritize product/character identity first, then scene, then style.

Recommended contact-sheet `image.generate` payload shape:

```json
{
  "count": 1,
  "generationMode": "reference-guided",
  "aspectRatio": "16:9",
  "prompt": "Image 1 is the product reference: preserve shape, material, logo position, and main color. Create one cinematic storyboard contact sheet with six panels arranged left-to-right, top-to-bottom. Each panel corresponds to one storyboard row: Panel 1 visual: ... Panel 2 visual: ... Panel 3 visual: ... Panel 4 visual: ... Panel 5 visual: ... Panel 6 visual: ... No visible labels, no captions, no table text.",
  "referenceImages": ["/absolute/path/to/product.png"]
}
```

Use `text-to-image` only when there are no usable visual references. Use `reference-guided` whenever reference images, subject assets, product photos, or prior generated images exist.

## Prompt Consistency Rules For Keyframe Images

When using image generation to build storyboard frames, consistency matters more than flourish.

You must:

- Define one stable description block for the subject.
- Define one stable description block for the environment.
- Reuse those same description phrases across all keyframe prompts.
- Only change the parts that truly differ from shot to shot.

The subject anchor should usually keep these elements stable:

- name / identity,
- gender or presentation if relevant,
- age range if relevant,
- hairstyle,
- clothing,
- key facial traits,
- key props,
- visual style.

The environment anchor should usually keep these elements stable:

- place / room type,
- layout,
- background elements,
- lighting mood,
- color palette,
- important objects,
- time-of-day logic if relevant.

Do not rewrite the whole scene in a different wording for each frame.
Do not keep inventing new environment details frame by frame.
Do not vary the character description unless that change is intentional.

## Keyframe Generation Order

If storyboard frames are generated:

1. Write one explicit **subject anchor** block.
2. Write one explicit **environment anchor** block.
3. Generate the core environment master frame first.
4. Generate each later keyframe individually.
5. Each later keyframe prompt should:
   - restate the same subject anchor,
   - restate the same environment anchor,
   - identify the core environment image as a reference,
   - describe only the shot-specific difference.

This is mandatory when the storyboard is later used for video generation.

If those storyboard frames have already been saved into a video project pack, later video generation should use those keyframes as the main visual references.
Do not keep reusing raw subject-library portraits or product stills as the primary visual input unless you truly need extra补充 angles or missing objects.

## Script Format

The pre-generation script must be shown as a Markdown table. Use these columns:

| Time | Picture | Sound | Shot |
| --- | --- | --- | --- |

Requirements:

- Before the table, explicitly state:
  - `视频时长`
  - `视频比例`
- `Time`: use compact ranges such as `0-2s`, `2-4s`, `4-6s`.
- `Picture`: describe subject action, motion, camera movement, scene changes, and what must stay stable.
- `Sound`: describe spoken line, ambient sound, music feel, silence, or rhythm cue.
- `Shot`: describe shot scale / framing, such as close-up, medium shot, wide shot, push-in, pan, tilt.
- Keep the table practical. It should be detailed enough to approve production, not a vague concept note.
- Each row should usually represent a shot or one stable motion segment.
- Shot duration should usually stay in the `1-3s` range.
- Without a clear user requirement, do not plan any row longer than `5s`.

After the table, add one short confirmation prompt, for example:

- `请确认这版视频脚本，我确认后再正式生成。`

If the user requests changes, revise the table first and wait again.
If duration or aspect ratio is not yet specified, propose a concrete default and include it in the confirmation block so the user can approve or change it.
If the script contains multiple shots, a named character, an important environment, or any continuity-sensitive sequence, also ask whether the user wants storyboard stills / keyframes first.

After the user confirms the video plan, the next assistant turn must either call `video.generate` or ask one blocking question required to build a valid payload. Do not reply that generation has started, is queued, or is complete until a `video.generate` tool result exists.
For chat/agent video creation, set `waitForCompletion: true` unless the user explicitly asks to run it in the background.

## Prompt Discipline

- Before writing the final `video.generate` prompt, reconstruct the current approved plan from the conversation context. Use the latest user-confirmed version, not an earlier draft.
- The reconstruction must include:
  - the user's original goal and attached/reference files,
  - the selected slogan/copy,
  - approved duration, aspect ratio, style, and platform/use case,
  - the latest approved storyboard table,
  - the generated storyboard preview image or keyframe asset path, if one exists,
  - every user correction after the first script draft.
- Do this silently as reasoning. Do not ask the user to repeat information that already exists in the conversation.
- The final prompt must be written from that reconstructed plan. Do not write a fresh generic product-video prompt.
- Before calling `video.generate`, run this self-check:
  - Does the payload include the latest approved storyboard as `storyboardShots` or `storyboardMarkdown`?
  - Does the prompt preserve the selected slogan/copy and the approved sound intent?
  - Does `durationSeconds` match the final storyboard time range?
  - Are the approved storyboard image/keyframe references included and labeled as strong references when available?
  - Does each beat contain concrete camera angle, framing, movement, and action details?
  - If any person appears, are posture, hand/arm movement, gaze, turn, prop interaction, and timing described?
- If any self-check item fails, revise the prompt/payload before calling `video.generate`; do not proceed with an incomplete prompt.
- If reference assets are attached, start the final generation prompt by identifying what each asset is for.
- Use explicit labels such as:
  - `Image 1: approved storyboard contact-sheet reference, strong reference for shot order, composition, framing, and visual continuity`
  - `Image 2: product reference, strong reference for shape, material, color, logo/details, and hardware`
  - `Image 3: Jamba portrait reference`
  - `Image 4: livestream background mood reference`
  - `Voice: Jamba voiceId for TTS = voice_xxx`
  - `Audio 1: generated Jamba TTS speech from the approved script`
- Do this before the motion/camera description so the model does not confuse multiple references.
- If a storyboard contact sheet, storyboard still, or generated keyframe has been approved, treat that image as the primary visual reference for final video generation.
- For final `reference-guided` video generation after storyboard approval, pass the approved storyboard image/keyframe path(s) in `referenceImages` whenever available. Do not keep using only the original product photo if an approved storyboard image exists.
- The final prompt must explicitly say the storyboard image is a **strong reference** for composition, shot order, camera framing, lighting direction, product placement, and continuity. The model should animate from this plan rather than reinterpret the whole scene.
- If a suitable finished generated speech audio exists and the chosen mode supports audio conditioning, treat it as a first-class reference asset instead of telling the user the platform cannot accept audio.
- For asset-library character 口播 videos, do not treat a saved `voiceId` as `Audio 1` directly. First synthesize the approved spoken script with TTS, then treat the generated audio asset as `Audio 1`.
- If the request uses an asset from the asset library and that asset has a saved `voiceId`, use that `voiceId` as the default TTS voice for the spoken script unless the user explicitly asks to disable it or replace it. Do not surface the old reference-audio filename as the important result; the important result is the resolved `voiceId`.
- For `text-to-video`, describe subject, camera, motion, environment, pacing, and visual style.
- For `reference-guided`, describe the desired movement and cinematic behavior while preserving and combining the important elements from the provided reference images.
- For `first-last-frame`, describe the transition between the first and last frame; do not rewrite the full scene unless the transition requires it.
- Avoid bloated prompts that restate the whole image contents when the real task is only a motion or transition edit.
- Focus on what should move, how the camera behaves, and what must stay stable.
- After the user confirms a storyboard table, do not downgrade that approved script into a single generic sentence.
- The final prompt must use professional cinematic language for every beat:
  - camera angle: eye-level, low angle, high angle, three-quarter angle, overhead, macro/product detail angle, over-the-shoulder, profile, frontal, rear tracking
  - framing and lens feel: wide shot, medium shot, medium close-up, close-up, extreme close-up, macro detail, shallow depth of field, compressed telephoto feel, natural wide-angle perspective
  - camera movement: slow dolly-in, lateral tracking shot, orbit move, pan, tilt, crane down, handheld micro-movement, locked-off shot, rack focus, reveal, whip-pan only when intentionally energetic
  - pacing and transition: hold, slow reveal, cut on motion, match cut, dissolve, speed ramp, final freeze frame
- For any beat involving a person, describe physical action precisely. Include posture, hand/arm movement, walking direction, turning motion, gaze, facial expression, interaction with product/prop, timing relative to the camera move, and what must remain stable.
- Do not use vague action words alone such as “show”, “display”, “model wears it”, or “fashion scene”. Replace them with concrete movement, for example: “model enters frame from camera right, lifts the bag strap onto the shoulder with the right hand, turns three-quarters toward camera, glances down at the gold zipper, then looks forward as the camera performs a slow dolly-in.”
- The final tool call must carry the approved storyboard structure in `payload.storyboardMarkdown` or `payload.storyboardShots`, so the host can compile the execution prompt from the actual approved beats.
- `payload.storyboardShots` should use one item per approved row with `time`, `picture`, `sound`, and `shot`.
- If you only pass a vague summary prompt after script confirmation, that is a failure because it discards the approved shot structure.

## Tool Usage

- Always use `Operate(resource="video", operation="generate", input={ ... })`.
- For asset-library character 口播 videos, resolve the voice before the video tool:
  - If the character has a ready `voiceId`, use it directly for TTS and do not inspect or summarize reference audio unless troubleshooting voice binding.
  - If the character has only a voice sample, call `Operate(resource="voice", operation="clone", input={ ... })`, wait for completion, and use the returned `voiceId`.
  - If no voice can be resolved, ask for a voice instead of generating a silent or generic-voice video.
- After resolving the voice, call `Operate(resource="voice", operation="speech", input={ ... })` before the video tool:
  - `input`: the full approved spoken script
  - `voiceId`: the selected character asset's stored voice id
  - `speed`: optional speech speed, 0.5-2.0; use subtle defaults such as 0.95 for steady narration or 1.05-1.12 for energetic口播
  - `pitch`: optional pitch, -12 to 12; keep 0 unless the character or user intent calls for a higher/lower tone
  - `emotion`: optional MiniMax emotion: `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`, `calm`, `fluent`, `whipser`/`whisper`
  - MiniMax text controls: use expressive punctuation such as `～`, `？`, `！`, `……`, `？！`, `！！` for tone, `<#0.6#>` for intentional pauses, and `(laughs)`, `(sighs)`, `(breath)`, `(chuckle)` for light expression when useful
  - Before building expressive or multi-beat TTS payloads, activate `tts-director` with `Operate(resource="skills", operation="invoke", input={ "name": "tts-director" })`
  - `segments`: use this for one long voice track with multiple emotional beats; submit once and let the media runtime merge the final audio
  - `title`: a clear audio asset title
  - `projectId` / `boundManuscriptPath`: include them when known
  - `waitForCompletion`: true when the runtime supports it, because video generation needs the completed audio asset
- Use the resulting TTS asset path or URL as `drivingAudio`; never use the character `voiceId` or raw voice sample as `drivingAudio`.
- Pass no reference images for `text-to-video`.
- Pass 1 to 5 reference images for `reference-guided`.
- After storyboard approval, put approved storyboard image/keyframe paths first in `referenceImages`, then product/character identity references, then scene/style references. Label the storyboard reference as strong.
- Pass exactly two reference images in `首帧,尾帧` order for `first-last-frame`.
- If a suitable finished audio asset exists, pass it as `drivingAudio` and describe it explicitly as `Audio 1` in the prompt preface.
- For `reference-guided`, if a suitable finished audio asset exists, also pass it as the mode's voice reference input.
- When a subject-library character is used for 口播, default to that character's saved `voiceId` for TTS, then pass the generated TTS audio as `Audio 1`. A ready `voiceId` supersedes any stored reference-audio filename for planning and reporting.
- If a video project pack already contains storyboard keyframes or image assets, prefer `video-project-path` or `video-project-id` together with those packaged assets as the main visual condition for `reference-guided`.
- When the final prompt, script, or reference path list is long, keep them in `payload` instead of stuffing everything into one shell-like command string.
- Keep the final generation prompt focused on execution details derived from the approved script.
- Do not dump the whole planning discussion into the generation prompt.
- When a storyboard has been approved, pass that exact approved table or row structure in payload. Recommended pattern:

```json
{
  "generationMode": "reference-guided",
  "referenceImages": [
    "/absolute/path/to/approved-storyboard-contact-sheet.png",
    "/absolute/path/to/product-or-character-reference.png"
  ],
  "referenceImageLabels": [
    "approved storyboard contact-sheet reference, strong reference for shot order, composition, framing, lighting direction, product placement, and continuity",
    "product or character identity reference, strong reference for shape, material, color, face/body identity, and distinctive details"
  ],
  "prompt": "Image 1 is the approved storyboard contact-sheet and must be followed as a strong reference for composition, shot order, framing, lighting direction, product placement, and continuity. Image 2 is the product/character identity reference and must preserve the visible identity details. Use professional cinematic camera language for every beat: specify angle, framing, lens feel, camera movement, pacing, and transition. If a person appears, describe posture, hand movement, gaze, body turn, prop interaction, and timing relative to the camera.",
  "storyboardShots": [
    {
      "time": "0-2s",
      "picture": "Jamba 手持戴森 V8 吸尘器，身体随节奏左右摇摆，吸尘器作为道具举起。",
      "sound": "使用 Jamba 已绑定 voiceId 生成的 TTS 口播，轻快节奏感。",
      "shot": "中景，人物全身入镜。"
    },
    {
      "time": "2-4s",
      "picture": "Jamba 一边跳舞一边用吸尘器做挥舞动作，身体转动，动作夸张有趣。",
      "sound": "节奏感音乐 + Jamba voiceId 生成的 TTS 声音。",
      "shot": "中近景，跟随人物移动。"
    }
  ]
}
```

- If the storyboard lives in a confirmed video project pack, pass `video-project-id` / `video-project-path`; the host will use the confirmed project script as storyboard input.
- If the user intent is ambiguous, explain the ambiguity briefly and pick the safer mode instead of faking certainty.
- For multi-video mode, generate each clip deliberately, then use `ffmpeg` tooling to concatenate them in storyboard order after all clips succeed.
