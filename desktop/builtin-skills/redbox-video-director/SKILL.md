---
name: redbox-video-director
description: Use when generating short videos with RedBox official video API, including motion clips, animated cover/video requests, reference-image video, image-to-video, and first/last-frame transitions. Produces a detailed shot script first, asks the user to confirm it, then chooses between text-to-video, reference-guided, and first-last-frame modes and calls the correct wan2.7 video model with prompt discipline focused on motion, reference elements, and transitions.
allowed-tools: app_cli
---

# RedBox Video Director

Use this skill before calling `app_cli(command="video generate ...")` for RedBox video work.

## Default Workflow

Before any video tool call, follow this order:

1. Clarify the intended video mode from the user's goal and assets.
2. Draft a concise but detailed video script for review.
3. Decide whether this should use a video project pack.
4. For multi-shot or context-heavy work, create a video project pack first.
5. Decide whether this should be a single-video job or a multi-video assembly.
6. If the script has multiple shots, continuity risk, character consistency requirements, or environment consistency requirements, proactively ask whether storyboard stills / keyframes should be generated first.
7. If storyboard stills are needed, design a stable keyframe-generation plan first.
8. Show the script to the user together with explicit video specs.
9. Ask for confirmation or revision.
10. Only after confirmation, call `app_cli(command="video generate ...")`.

If the user has not yet confirmed the script, do not generate the video.

## Video Project Pack Rule

For multi-shot videos, long-context videos, continuity-sensitive videos, or videos likely to go through several revisions, you should first create a video project pack with:

- `app_cli(command="video project-create --title ... --duration ... --aspect-ratio ... --mode ...")`

The project pack lives in:

- `media/video-projects/<id>/`

It should be used to keep these files together:

- `manifest.json`
- `brief.md`
- `script.md`
- reference images
- voice references
- storyboard keyframes
- generated clips
- final output

After the pack is created:

- write the user brief into `brief.md`
- write the approved script into `script.md`
- keep later keyframes, clips, and outputs in the same pack whenever possible

This is preferred over keeping all video context only inside chat history.

## Hard Rules

- RedBox video generation is locked to the RedBox official video route.
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

- If the request has multiple shots, clear continuity requirements, or a risk of visual drift, ask one more question after drafting the table:
  - whether storyboard images / keyframes should be generated first.
- If storyboard images are generated, later video generation should preferentially use image-based modes, and for transition-heavy segments should prefer `first-last-frame`.

## Storyboard-First Rule

When the request is complex enough that video quality depends on stable keyframes, you must prefer a storyboard-first workflow.

Use storyboard-first when one or more of these is true:

- There are many shots or visual beats.
- Character identity must remain highly stable.
- Environment continuity matters.
- The user wants a sequence that later becomes one assembled video.
- The user explicitly asks for storyboard frames / keyframes / 分镜图.

When any of the above is true, do not silently continue to video generation. You must explicitly ask the user whether they want image-generated storyboard keyframes first.

When storyboard-first is used, follow this exact process:

1. First design a **core environment reference image**.
2. Generate that image first.
3. Then generate later keyframes one by one.
4. Each later keyframe must use the core environment reference image as a reference image.
5. If a character subject already exists in the subject library, the subject reference and the core environment reference should both be preserved across later keyframes.
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
- If a suitable subject voice reference exists and the chosen mode supports audio conditioning, treat it as a first-class reference asset instead of telling the user the platform cannot accept audio.
- If the request uses a subject from the subject library and that subject has a saved voice reference, you should treat that voice as the default audio reference for the video unless the user explicitly asks to disable it or replace it.
- For `text-to-video`, describe subject, camera, motion, environment, pacing, and visual style.
- For `reference-guided`, describe the desired movement and cinematic behavior while preserving and combining the important elements from the provided reference images.
- For `first-last-frame`, describe the transition between the first and last frame; do not rewrite the full scene unless the transition requires it.
- Avoid bloated prompts that restate the whole image contents when the real task is only a motion or transition edit.
- Focus on what should move, how the camera behaves, and what must stay stable.

## Tool Usage

- Always use `app_cli(command="video generate ...")`.
- Pass no reference images for `text-to-video`.
- Pass 1 to 5 reference images for `reference-guided`.
- Pass exactly two reference images in `首帧,尾帧` order for `first-last-frame`.
- If a suitable voice reference exists, pass it as `drivingAudio` and describe it explicitly as `Audio 1` in the prompt preface.
- For `reference-guided`, if a suitable voice reference exists, also pass it as the mode's voice reference input.
- When a subject-library character is used, default to that character's saved voice reference as `Audio 1`.
- If a video project pack already contains storyboard keyframes, prefer `video-project-id` + those keyframes as the main visual condition for `reference-guided`.
- Keep the final generation prompt focused on execution details derived from the approved script.
- Do not dump the whole planning discussion into the generation prompt.
- If the user intent is ambiguous, explain the ambiguity briefly and pick the safer mode instead of faking certainty.
- For multi-video mode, generate each clip deliberately, then use `ffmpeg` tooling to concatenate them in storyboard order after all clips succeed.
