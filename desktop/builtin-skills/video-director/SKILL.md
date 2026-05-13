---
name: video-director
description: Use when generating short videos, including motion clips, animated cover/video requests, reference-image video, image-to-video, and first/last-frame transitions. Produces a detailed shot script first, then generates storyboard contact-sheet preview images through image.generate using four/six/nine-panel grids, including any product or visual reference images, asks the user to confirm, and only then calls the correct video model.
allowedRuntimeModes: [chatroom, redclaw]
allowedTools: [workflow]
activationScope: turn
---

# Video Director

Use this skill before calling `Operate(resource="video", operation="generate", input={ ... })` for video work.

## Default Workflow

Before any video tool call, follow this order:

1. Clarify the intended video mode from the user's goal and assets.
2. Draft a concise but detailed video script for review.
3. Generate storyboard contact-sheet preview image(s) with `Operate(resource="image", operation="generate", input={ ... })`.
4. Show the script, storyboard preview image(s), and explicit video specs together.
5. Ask for confirmation or revision.
6. Default to direct video generation after confirmation.
7. Only use a video project pack if the user explicitly asks for a project/package/editor workflow, or the task is already bound to an existing pack.
8. Decide whether this should be a single-video job or a multi-video assembly.
9. Only after confirmation, call `Operate(resource="video", operation="generate", input={ ... })`.

If the user has not yet confirmed the script, do not generate the video.

The storyboard contact-sheet preview is mandatory after the first shot script is written. It is not the same as final video keyframes; it is a quick visual proof of the planned shot sequence so the user can approve direction, composition, product placement, and continuity before video generation.

## Asset-Library Character Talking-Head Rule

When the user wants a talking-head / 口播 video using a character from the asset library, do not send the character image directly to video generation and hope the model invents the speech.

Use this exact order:

1. **Script and storyboard first**
   - Confirm the final spoken script.
   - Confirm the storyboard / shot table.
   - The `Sound` column must contain the actual spoken lines, not vague labels like “角色讲解”.
2. **Generate the complete voice track**
   - Read the selected character asset and use its stored `voiceId` / `voice_id`.
   - Call `Operate(resource="voice", operation="speech", input={ ... })` with the full approved spoken script.
   - Prefer one complete audio asset for the whole talking-head segment unless the user explicitly wants separate clips.
   - Wait for the audio result before starting video generation.
3. **Generate video with both references**
   - Use the selected character image as the visual reference.
   - Use the newly generated complete TTS audio asset as `drivingAudio`.
   - Then call `Operate(resource="video", operation="generate", input={ ... })`, normally in `reference-guided` mode.

This is mandatory because the generated audio must be complete and aligned with the approved script. A character voice id is not a finished audio track; it must be converted to audio with TTS before video generation.

If the character asset has no stored `voiceId`, stop and ask the user to choose/bind a voice before generating the video.

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
- `remotion.scene.json`
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
- Do not add extra invented shots to fill empty panels.
- Keep the panel order left-to-right, top-to-bottom, matching the script table.
- The preview should show composition, subject placement, camera scale, product/prop position, action beat, lighting, and style continuity.
- Do not render planning labels, shot numbers, table headers, or internal notes inside the image unless the user explicitly asks for visible text.
- The contact sheet is for visual approval only; it does not replace the approved Markdown script or `storyboardShots` payload used later for video generation.

Reference handling is mandatory:

- If the user attached or selected product images, character images, brand images, scene references, or previous generated images, pass them to `image.generate` as `referenceImages`.
- If the reference comes from the asset library, read the asset first and pass its resolved image path(s) through `referenceImages` or `subjectIds`.
- If several references exist, include prompt preface lines that define each role, such as `Image 1: product shape and material reference`, `Image 2: character identity reference`, `Image 3: scene mood reference`.
- Do not describe reference images only in prose while leaving them out of the tool input.
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

## Prompt Discipline

- If reference assets are attached, start the final generation prompt by identifying what each asset is for.
- Use explicit labels such as:
  - `Image 1: Jamba portrait reference`
  - `Image 2: livestream background mood reference`
  - `Audio 1: Jamba voice reference for tone and speaking rhythm`
- Do this before the motion/camera description so the model does not confuse multiple references.
- If a suitable finished audio reference exists and the chosen mode supports audio conditioning, treat it as a first-class reference asset instead of telling the user the platform cannot accept audio.
- For asset-library character 口播 videos, do not treat a saved `voiceId` as `Audio 1` directly. First synthesize the approved spoken script with TTS, then treat the generated audio asset as `Audio 1`.
- If the request uses an asset from the asset library and that asset has a saved `voiceId`, use that `voiceId` as the default TTS voice for the spoken script unless the user explicitly asks to disable it or replace it.
- For `text-to-video`, describe subject, camera, motion, environment, pacing, and visual style.
- For `reference-guided`, describe the desired movement and cinematic behavior while preserving and combining the important elements from the provided reference images.
- For `first-last-frame`, describe the transition between the first and last frame; do not rewrite the full scene unless the transition requires it.
- Avoid bloated prompts that restate the whole image contents when the real task is only a motion or transition edit.
- Focus on what should move, how the camera behaves, and what must stay stable.
- After the user confirms a storyboard table, do not downgrade that approved script into a single generic sentence.
- The final tool call must carry the approved storyboard structure in `payload.storyboardMarkdown` or `payload.storyboardShots`, so the host can compile the execution prompt from the actual approved beats.
- `payload.storyboardShots` should use one item per approved row with `time`, `picture`, `sound`, and `shot`.
- If you only pass a vague summary prompt after script confirmation, that is a failure because it discards the approved shot structure.

## Tool Usage

- Always use `Operate(resource="video", operation="generate", input={ ... })`.
- For asset-library character 口播 videos, call `Operate(resource="voice", operation="speech", input={ ... })` before the video tool:
  - `input`: the full approved spoken script
  - `voiceId`: the selected character asset's stored voice id
  - `title`: a clear audio asset title
  - `projectId` / `boundManuscriptPath`: include them when known
  - `waitForCompletion`: true when the runtime supports it, because video generation needs the completed audio asset
- Pass no reference images for `text-to-video`.
- Pass 1 to 5 reference images for `reference-guided`.
- Pass exactly two reference images in `首帧,尾帧` order for `first-last-frame`.
- If a suitable finished audio asset exists, pass it as `drivingAudio` and describe it explicitly as `Audio 1` in the prompt preface.
- For `reference-guided`, if a suitable finished audio asset exists, also pass it as the mode's voice reference input.
- When a subject-library character is used for 口播, default to that character's saved `voiceId` for TTS, then pass the generated TTS audio as `Audio 1`.
- If a video project pack already contains storyboard keyframes or image assets, prefer `video-project-path` or `video-project-id` together with those packaged assets as the main visual condition for `reference-guided`.
- When the final prompt, script, or reference path list is long, keep them in `payload` instead of stuffing everything into one shell-like command string.
- Keep the final generation prompt focused on execution details derived from the approved script.
- Do not dump the whole planning discussion into the generation prompt.
- When a storyboard has been approved, pass that exact approved table or row structure in payload. Recommended pattern:

```json
{
  "storyboardShots": [
    {
      "time": "0-2s",
      "picture": "Jamba 手持戴森 V8 吸尘器，身体随节奏左右摇摆，吸尘器作为道具举起。",
      "sound": "Jamba 声音参考配音，轻快节奏感。",
      "shot": "中景，人物全身入镜。"
    },
    {
      "time": "2-4s",
      "picture": "Jamba 一边跳舞一边用吸尘器做挥舞动作，身体转动，动作夸张有趣。",
      "sound": "节奏感音乐 + Jamba 声音。",
      "shot": "中近景，跟随人物移动。"
    }
  ]
}
```

- If the storyboard lives in a confirmed video project pack, pass `video-project-id` / `video-project-path`; the host will use the confirmed project script as storyboard input.
- If the user intent is ambiguous, explain the ambiguity briefly and pick the safer mode instead of faking certainty.
- For multi-video mode, generate each clip deliberately, then use `ffmpeg` tooling to concatenate them in storyboard order after all clips succeed.
