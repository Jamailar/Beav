use crate::runtime::SkillRecord;

pub fn builtin_skill_records() -> Vec<SkillRecord> {
    vec![
        SkillRecord {
            name: "cover-builder".to_string(),
            description: "封面生成辅助技能".to_string(),
            location: "redbox://skills/cover-builder".to_string(),
            body: "---\nallowedRuntimeModes: [redclaw]\nallowedToolPack: redclaw\nallowedTools: [bash, app_cli]\nhookMode: inline\nautoActivate: false\ncontextNote: 需要明确输出封面标题、构图与提示词。\n---\n# Cover Builder\n\n用于把标题、平台调性和参考素材转成封面方案的内置技能。\n\n## 输出要求\n\n- 提供 3-5 个封面标题方案。\n- 标注主视觉、构图、色彩、字体建议。\n- 如果配置了图片生成 endpoint，优先生成真实封面资产；否则输出可执行的封面提示词。".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "remotion-best-practices".to_string(),
            description: "视频编辑内置 Remotion 官方最佳实践技能".to_string(),
            location: "redbox://skills/remotion-best-practices".to_string(),
            body: "---\nallowedRuntimeModes: [video-editor]\nallowedTools: [bash, app_cli, redbox_editor]\nhookMode: inline\nautoActivate: true\ncontextNote: 当前视频运行时默认启用 Remotion 官方最佳实践知识包。优先按 Composition / Sequence / timing / assets 的思路设计动画，但最终仍以 remotion.scene.json 为宿主真相层，并以 baseMedia.outputPath 作为基础视频。\npromptPrefix: 你当前必须遵守 remotion-best-practices：先读取当前 Remotion 工程状态，再决定 composition/scene 边界、主体 element、timing 与 assets；不要直接虚构任意 React 代码或 CSS 动画。\npromptSuffix: 只使用宿主支持的 Remotion scene/entity/animation 能力落地结果。若官方 Remotion 能力超出宿主范围，必须显式降级为可预览的 scene patch，而不是假装已实现。\n---\n# Remotion Best Practices\n\n用于 `video-editor` 运行时的内置 Remotion 官方最佳实践技能。\n\n- 先 `redbox_editor(action=project_read)` 了解当前视频工程，再 `redbox_editor(action=remotion_read)` 读取当前 Remotion 工程状态。\n- 运行时会自动加载 compositions / animations / sequencing / timing / assets / text-animations / subtitles / transitions / calculate-metadata。\n- 先明确 Composition / scene 边界，再确定主体 element、timing、assets、字幕与导出默认项。\n- 结果必须回写 `remotion.scene.json`，不要退化成脱离宿主的自由 TSX 代码。\n- 若脚本没有明确要求屏幕文字，默认不要生成 `overlayTitle`、`overlayBody`、`overlays` 或解释性 `text` entity；优先只保留动画主体。\n- 不要调用旧时间轴动作编辑视频；基础视频剪辑走 `ffmpeg_edit`，图层动画走 `remotion_*`。\n- 禁止使用 CSS transition、CSS animation 或 Tailwind animate 类名来实现 Remotion 动画。".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "redbox-video-director".to_string(),
            description: "短视频生成导演技能，用于 RedBox 官方视频 API 的分镜脚本确认、参考图引导、首尾帧过渡和多镜头生成。".to_string(),
            location: "redbox://skills/redbox-video-director".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/redbox-video-director/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "skill-creator".to_string(),
            description: "技能创建指导技能，用于创建或更新 SKILL.md、脚本、参考文档、资源和 agents/openai.yaml。".to_string(),
            location: "redbox://skills/skill-creator".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/skill-creator/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "richpost-layout-designer".to_string(),
            description: "图文排版专用技能，用于 richpost 的主题、字体、分页和页面样式调整，并强制保持正文内容不变。".to_string(),
            location: "redbox://skills/richpost-layout-designer".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/richpost-layout-designer/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "richpost-theme-editor".to_string(),
            description: "图文主题编辑专用技能，用于 richpost 的首页、内容页、尾页母版与 layout tokens 调整，并强制只改模板层不改正文。".to_string(),
            location: "redbox://skills/richpost-theme-editor".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/richpost-theme-editor/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "longform-layout-designer".to_string(),
            description: "长文排版专用技能，用于 longform 的母版、分栏、字体和 layout/wechat HTML 样式调整，并强制保持正文内容不变。".to_string(),
            location: "redbox://skills/longform-layout-designer".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/longform-layout-designer/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "image-prompt-optimizer".to_string(),
            description: "当任务准备调用 app_cli(image generate) 做文生图、参考图引导或图生图时，先用它整理最终提示词，避免主体跑偏、风格失控和把说明文字画进图里。".to_string(),
            location: "redbox://skills/image-prompt-optimizer".to_string(),
            body: include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../builtin-skills/image-prompt-optimizer/SKILL.md"
            ))
            .to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
        SkillRecord {
            name: "writing-style".to_string(),
            description: "当任务进入选题 framing、标题拟定、完整写稿、改写、扩写或润色时，用它统一语气、结构和禁区。".to_string(),
            location: "redbox://skills/writing-style".to_string(),
            body: "---\nallowedRuntimeModes: [wander, redclaw, chatroom]\nhookMode: inline\nautoActivate: false\nactivationScope: session\nactivationHint: 当任务进入选题 framing、标题拟定、完整写稿、改写、扩写、润色、内容表达方式调整，或用户明确要求沿用既定写作风格时，先调用 `app_cli(command=\"skills invoke --name writing-style\")`；非写作任务不要启用它。\ncontextNote: 这是当前空间统一的写作风格底盘。若任务已经进入选题 framing、标题拟定、完整写稿、改写、扩写、润色，或用户明确提到 writing-style，应优先加载它；非写作任务不要让它干扰其他决策。\npromptPrefix: 你当前已加载 writing-style。凡是涉及选题 framing、完整写稿、改写、扩写、润色或内容表达方式调整，都先按这份技能执行，避免模板化 AI 文案。\npromptSuffix: 如果当前任务不是写作，就不要让 writing-style 主导其他决策；如果当前任务是写作，标题、内容方向、正文和文案细节都必须体现这份技能的约束。\nmaxPromptChars: 2400\n---\n# Writing Style\n\n用于当前空间所有写作相关任务的统一风格底盘技能。\n\n推荐在这些场景加载它，选题 framing、标题拟定、内容方向判断、正文创作、改写、扩写、润色、复盘，以及用户明确要求按既定写作风格继续写的时候。\n\n## 强制规则\n\n- 涉及写作、改写、扩写、润色、复盘，或选题 framing 的任务，都先遵守这份技能。\n- 漫步阶段的标题和内容方向，与 RedClaw 阶段的完整稿件、标签、封面文案，使用同一套风格底盘。\n- 标题和方向先追求具体、有人味、真实张力，再追求工整。\n- 没有真实细节时，不要硬装第一手经历或情绪。\n- 素材是启发、证据和细节候选，不是必须逐条塞进正文的原料。\n- 后续创作优先内容质量、传播性和完成度；若某条素材只适合提供 hook、结构、语气、冲突或视角启发，可以只学其方法，不必强行显式使用。\n- 如果某个素材会拖累成稿质量、破坏叙事完整性或让表达变得生硬，可以舍弃，不要为了“用了素材”而牺牲成稿。\n- 如果当前任务不是写作，不要让本技能主导非写作决策。\n\n## 基础目标\n\n- 像活人说话，不像报告、客服话术或课程总结。\n- 先讲具体场景、动作、问题和处境，再讲抽象判断。\n- 可以有观点，但不要写成无懈可击的上帝视角。\n- 能承认不确定，就不要假装确定。\n\n## 选题判断\n\n先用 HKR 做快速质检。\n\n- H，是否足够有趣，让人想继续看。\n- K，是否真的有信息量，不是在重复常识。\n- R，是否有情绪、处境、冲突或共鸣点。\n\n如果素材只有主题，没有细节、冲突、观点或切口，不要硬写成空方向。标题要落到具体对象、具体处境、反差、问题，或一个可被读者立刻感知的 tension。\n\n## 语言与节奏\n\n- 长短句混用，短段优先。\n- 允许适度口语和停顿感，但不要为了口语而装腔。\n- 转场尽量自然，不要写成报告式大纲。\n\n## 绝对禁区\n\n- 禁用“首先、其次、最后”“综上所述”“值得注意的是”“不难发现”“让我们来看看”。\n- 禁用“说白了”“这意味着”“意味着什么”“本质上”“换句话说”“不可否认”。\n- 禁用“从某素材延展出的内容选题”“围绕这组素材提炼一个方向”这类 AI 占位句。\n- 不编造经历、情绪、案例，不用宏大空话开头。\n- 不要把“把素材都用上”当成目标本身。\n\n## 自检\n\n- 有没有具体场景、对象、动作、问题。\n- 有没有表面像人话，底层判断却很空。\n- 有没有写得太匀速、太整齐、太像模板。\n- 有没有为了照顾素材覆盖率，牺牲标题力度、开头张力或正文自然度。".to_string(),
            source_scope: Some("builtin".to_string()),
            is_builtin: Some(true),
            disabled: Some(false),
        },
    ]
}
