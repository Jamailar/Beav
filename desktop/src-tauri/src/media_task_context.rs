use serde_json::{json, Value};
use std::collections::HashSet;

use crate::{payload_string, AppStore, ChatMessageRecord};

const ACTIVE_MEDIA_TASK_KEY: &str = "activeMediaTask";
const MAX_TASK_SOURCE_CHARS: usize = 12_000;
const MAX_APPROVED_TEXT_CHARS: usize = 2_400;

pub(crate) fn active_media_task_prompt_section(
    store: &AppStore,
    session_id: Option<&str>,
) -> String {
    let Some(task) = active_media_task_for_session(store, session_id) else {
        return String::new();
    };
    let task_id =
        payload_string(&task, "taskId").unwrap_or_else(|| "active-media-task".to_string());
    let subject_name = task
        .pointer("/subject/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let voice_id = task
        .pointer("/subject/voiceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let script_title = task
        .pointer("/script/title")
        .and_then(Value::as_str)
        .unwrap_or("");
    let approved_text = task
        .pointer("/script/approvedText")
        .and_then(Value::as_str)
        .unwrap_or("");

    let mut lines = vec![
        "Active Media Task:".to_string(),
        format!("- taskId: {task_id}"),
        "- Continuation rule: short replies such as `继续`, `继续做音频`, or `先做音频` continue this exact task. Do not replace the script with a new marketing, SOP, or generic口播文案.".to_string(),
        "- For `voice.speech`, the `input` must be the active script text or a direct chunk from it, and `voiceId` must match the active subject voice when provided.".to_string(),
        "- `voice.speech` controls are model-specific. For CosyVoice models such as cosyvoice-v3.5-plus, first activate `cosyvoice-ssml` for expressive SSML with `Operate(resource=\"skills\", operation=\"invoke\", input={ \"name\": \"cosyvoice-ssml\" })`; activation only updates instructions and will not return SSML. For almost all multi-sentence CosyVoice audio, use ordered `segments`; each segment should contain one complete `<speak rate=\"...\" pitch=\"...\" volume=\"...\">...</speak>` SSML `input` plus a segment-specific `prompt`, and the media runtime will merge the final audio. Use a single CosyVoice `input` only for very short neutral one-beat speech. Do not send `emotion`, `<prosody>`, or MiniMax pause markers. For MiniMax models such as speech-2.8-turbo, activate `tts-director` for expressive work and use `emotion`, speed/pitch, MiniMax pause markers like <#0.6#>, and ordered `segments` when needed.".to_string(),
    ];
    if !subject_name.trim().is_empty() {
        lines.push(format!("- subjectName: {subject_name}"));
    }
    if !voice_id.trim().is_empty() {
        lines.push(format!("- voiceId: {voice_id}"));
    }
    if !script_title.trim().is_empty() {
        lines.push(format!("- scriptTitle: {script_title}"));
    }
    if !approved_text.trim().is_empty() {
        lines.push("- approvedScriptAnchors:".to_string());
        lines.push(truncate_chars(approved_text, MAX_APPROVED_TEXT_CHARS));
    }
    lines.join("\n")
}

pub(crate) fn validate_voice_speech_payload(
    store: &AppStore,
    payload: &Value,
) -> Result<(), Value> {
    if payload
        .get("allowScriptMismatch")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let session_id =
        payload_string(payload, "sessionId").or_else(|| payload_string(payload, "ownerSessionId"));
    let Some(task) = active_media_task_for_session(store, session_id.as_deref()) else {
        return Ok(());
    };
    let expected_voice_id = task
        .pointer("/subject/voiceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let (Some(expected), Some(actual)) = (expected_voice_id, payload_string(payload, "voiceId"))
    {
        if actual.trim() != expected {
            return Err(mismatch_error(
                "VOICE_SPEECH_VOICE_MISMATCH",
                "voice.speech voiceId does not match the active media task subject voice.",
                &task,
            ));
        }
    }

    let Some(input) = voice_speech_input_text(payload) else {
        return Ok(());
    };
    let approved_text = task
        .pointer("/script/approvedText")
        .and_then(Value::as_str)
        .unwrap_or("");
    if approved_text.trim().is_empty() || input.trim().chars().count() < 12 {
        return Ok(());
    }
    if script_matches(&input, approved_text) {
        return Ok(());
    }
    Err(mismatch_error(
        "VOICE_SPEECH_SCRIPT_MISMATCH",
        "voice.speech input does not match the active media task script.",
        &task,
    ))
}

fn voice_speech_input_text(payload: &Value) -> Option<String> {
    payload_string(payload, "input").or_else(|| {
        let joined = payload
            .get("segments")?
            .as_array()?
            .iter()
            .filter_map(|segment| {
                payload_string(segment, "input").or_else(|| payload_string(segment, "text"))
            })
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if joined.trim().is_empty() {
            None
        } else {
            Some(joined)
        }
    })
}

fn active_media_task_for_session(store: &AppStore, session_id: Option<&str>) -> Option<Value> {
    let session_id = session_id?;
    let session = store
        .chat_sessions
        .iter()
        .find(|item| item.id == session_id)?;
    if let Some(task) = session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(ACTIVE_MEDIA_TASK_KEY))
        .filter(|value| value.is_object())
    {
        return Some(task.clone());
    }
    derive_active_media_task_from_messages(store, session_id)
}

fn derive_active_media_task_from_messages(store: &AppStore, session_id: &str) -> Option<Value> {
    let mut messages = store
        .chat_messages
        .iter()
        .filter(|item| item.session_id == session_id)
        .collect::<Vec<_>>();
    messages.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    let recent = messages
        .into_iter()
        .rev()
        .take(12)
        .collect::<Vec<&ChatMessageRecord>>();
    if recent.is_empty() {
        return None;
    }
    let mut source = recent
        .iter()
        .rev()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if source.chars().count() > MAX_TASK_SOURCE_CHARS {
        source = truncate_chars(&source, MAX_TASK_SOURCE_CHARS);
    }
    if !looks_like_media_task(&source) {
        return None;
    }
    let script_title = extract_book_title(&source)?;
    let subject_name = extract_subject_name(&source);
    let voice_id = extract_voice_id(&source).or_else(|| {
        subject_name
            .as_deref()
            .and_then(|name| subject_voice_id(store, name))
    });
    let approved_text = extract_approved_script_anchors(&source);
    Some(json!({
        "taskId": format!("derived-media-task-{session_id}"),
        "source": "session-history",
        "kind": "media_generation",
        "nextAction": "continue",
        "subject": {
            "name": subject_name,
            "voiceId": voice_id,
        },
        "script": {
            "title": script_title,
            "approvedText": approved_text,
        },
        "strictScriptGuard": !approved_text.trim().is_empty(),
    }))
}

fn looks_like_media_task(source: &str) -> bool {
    let has_media = ["音频", "视频", "TTS", "tts", "voice.speech", "朗诵", "口播"]
        .iter()
        .any(|needle| source.contains(needle));
    let has_continuation = ["继续", "先做音频", "做音频"]
        .iter()
        .any(|needle| source.contains(needle));
    has_media && has_continuation
}

fn extract_book_title(source: &str) -> Option<String> {
    let start = source.find('《')?;
    let tail = &source[start + '《'.len_utf8()..];
    let end = tail.find('》')?;
    non_empty(tail[..end].trim())
}

fn extract_subject_name(source: &str) -> Option<String> {
    if let Some(index) = source.find('@') {
        let candidate = source[index + 1..]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
            .collect::<String>();
        if let Some(value) = non_empty(candidate.trim()) {
            return Some(value);
        }
    }
    for marker in ["角色:", "角色：", "subjectName:", "subjectName："] {
        if let Some(index) = source.find(marker) {
            let candidate = source[index + marker.len()..]
                .lines()
                .next()
                .unwrap_or("")
                .split(|ch: char| ch.is_whitespace() || ch == '（' || ch == '(')
                .next()
                .unwrap_or("")
                .trim();
            if let Some(value) = non_empty(candidate) {
                return Some(value);
            }
        }
    }
    None
}

fn extract_voice_id(source: &str) -> Option<String> {
    source
        .split(|ch: char| {
            ch.is_whitespace() || ch == '`' || ch == '"' || ch == '\'' || ch == ',' || ch == '，'
        })
        .find(|token| token.starts_with("voice_") && token.len() >= 12)
        .and_then(non_empty)
}

fn subject_voice_id(store: &AppStore, subject_name: &str) -> Option<String> {
    store
        .subjects
        .iter()
        .find(|subject| subject.name.eq_ignore_ascii_case(subject_name))
        .and_then(|subject| subject.voice.as_ref())
        .and_then(|voice| payload_string(voice, "voiceId").or_else(|| payload_string(voice, "id")))
}

fn extract_approved_script_anchors(source: &str) -> String {
    let mut snippets = Vec::<String>::new();
    collect_quoted_snippets(source, '"', '"', &mut snippets);
    collect_quoted_snippets(source, '“', '”', &mut snippets);
    let mut seen = HashSet::<String>::new();
    snippets
        .into_iter()
        .filter(|item| seen.insert(item.clone()))
        .take(12)
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_quoted_snippets(source: &str, open: char, close: char, output: &mut Vec<String>) {
    let mut rest = source;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len_utf8()..];
        let Some(end) = after.find(close) else {
            break;
        };
        let snippet = after[..end].trim();
        if snippet.chars().count() >= 6 && snippet.chars().any(is_cjk) {
            output.push(snippet.to_string());
        }
        rest = &after[end + close.len_utf8()..];
    }
}

fn script_matches(input: &str, approved_text: &str) -> bool {
    let input_norm = normalize_for_match(input);
    let approved_norm = normalize_for_match(approved_text);
    if input_norm.is_empty() || approved_norm.is_empty() {
        return true;
    }
    if approved_norm.contains(&input_norm) || input_norm.contains(&approved_norm) {
        return true;
    }
    overlap_ratio(&input_norm, &approved_norm) >= 0.08
}

fn overlap_ratio(input: &str, approved: &str) -> f64 {
    let approved_grams = char_grams(approved, 2).into_iter().collect::<HashSet<_>>();
    if approved_grams.is_empty() {
        return 1.0;
    }
    let input_grams = char_grams(input, 2);
    if input_grams.is_empty() {
        return 1.0;
    }
    let overlap = input_grams
        .iter()
        .filter(|gram| approved_grams.contains(*gram))
        .count();
    overlap as f64 / input_grams.len() as f64
}

fn char_grams(value: &str, size: usize) -> Vec<String> {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() < size {
        return Vec::new();
    }
    chars
        .windows(size)
        .map(|window| window.iter().collect::<String>())
        .collect()
}

fn normalize_for_match(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || is_cjk(*ch))
        .flat_map(char::to_lowercase)
        .collect()
}

fn mismatch_error(code: &str, message: &str, task: &Value) -> Value {
    json!({
        "code": code,
        "message": message,
        "activeTask": {
            "taskId": payload_string(task, "taskId"),
            "subjectName": task.pointer("/subject/name").and_then(Value::as_str),
            "voiceId": task.pointer("/subject/voiceId").and_then(Value::as_str),
            "scriptTitle": task.pointer("/script/title").and_then(Value::as_str),
            "scriptAnchors": task.pointer("/script/approvedText").and_then(Value::as_str),
        },
        "suggestedFix": "Continue the active media task: use the active script title/anchors as voice.speech input, keep the active voiceId, or set allowScriptMismatch=true only when the user explicitly changes the task."
    })
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_cjk(ch: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&ch)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut result = value.chars().take(limit).collect::<String>();
    result.push_str("...");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChatSessionRecord, SubjectRecord};

    fn session(id: &str) -> ChatSessionRecord {
        ChatSessionRecord {
            id: id.to_string(),
            title: "Jamba recites".to_string(),
            created_at: "2026-05-14T00:00:00Z".to_string(),
            updated_at: "2026-05-14T00:00:00Z".to_string(),
            metadata: None,
            deleted_at: None,
            starred: false,
            archived: false,
            archived_at: None,
        }
    }

    fn message(session_id: &str, content: &str) -> ChatMessageRecord {
        ChatMessageRecord {
            id: format!("msg-{session_id}"),
            session_id: session_id.to_string(),
            role: "assistant".to_string(),
            content: content.to_string(),
            display_content: None,
            attachment: None,
            metadata: None,
            created_at: "2026-05-14T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn derives_media_task_from_recent_recitation_history() {
        let mut store = AppStore::default();
        store.chat_sessions.push(session("s1"));
        store.subjects.push(SubjectRecord {
            id: "subject-jamba".to_string(),
            name: "Jamba".to_string(),
            category_id: None,
            description: None,
            tags: Vec::new(),
            attributes: Vec::new(),
            image_paths: Vec::new(),
            voice_path: None,
            video_path: None,
            voice_script: None,
            voice: Some(json!({ "voiceId": "voice_2eee156a6468427bb185a831" })),
            created_at: "2026-05-14T00:00:00Z".to_string(),
            updated_at: "2026-05-14T00:00:00Z".to_string(),
            absolute_image_paths: Vec::new(),
            preview_urls: Vec::new(),
            primary_preview_url: None,
            absolute_voice_path: None,
            voice_preview_url: None,
            absolute_video_path: None,
            video_preview_url: None,
        });
        store.chat_messages.push(message(
            "s1",
            "做一个 @Jamba 朗诵《将进酒》的视频。继续做音频。分镜声音：\"君不见黄河之水天上来\"，\"奔流到海不复回\"。",
        ));
        let task = active_media_task_for_session(&store, Some("s1")).expect("task");
        assert_eq!(
            task.pointer("/script/title").and_then(Value::as_str),
            Some("将进酒")
        );
        assert_eq!(
            task.pointer("/subject/voiceId").and_then(Value::as_str),
            Some("voice_2eee156a6468427bb185a831")
        );
    }

    #[test]
    fn voice_guard_rejects_unrelated_tts_copy() {
        let mut store = AppStore::default();
        store.chat_sessions.push(session("s1"));
        store.chat_messages.push(message(
            "s1",
            "做一个 @Jamba 朗诵《将进酒》的视频。继续做音频。\"君不见黄河之水天上来\" \"奔流到海不复回\"",
        ));
        let error = validate_voice_speech_payload(
            &store,
            &json!({
                "sessionId": "s1",
                "voiceId": "voice_2eee156a6468427bb185a831",
                "input": "你是否也遇到过内容发布没有 SOP、团队协作效率低的问题？今天给你一套标准流程。"
            }),
        )
        .expect_err("unrelated copy should be rejected");
        assert_eq!(
            error.get("code").and_then(Value::as_str),
            Some("VOICE_SPEECH_SCRIPT_MISMATCH")
        );
    }

    #[test]
    fn voice_guard_accepts_script_chunk() {
        let mut store = AppStore::default();
        store.chat_sessions.push(session("s1"));
        store.chat_messages.push(message(
            "s1",
            "做一个 @Jamba 朗诵《将进酒》的视频。继续做音频。\"君不见黄河之水天上来\" \"奔流到海不复回\"",
        ));
        validate_voice_speech_payload(
            &store,
            &json!({
                "sessionId": "s1",
                "input": "君不见黄河之水天上来，奔流到海不复回。"
            }),
        )
        .expect("script chunk should pass");
    }
}
