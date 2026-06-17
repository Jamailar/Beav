use serde_json::Value;

pub(super) const TASK_SCOPED_METADATA_FIELDS: &[&str] = &[
    "taskHints",
    "taskBrief",
    "intent",
    "platform",
    "taskType",
    "taskIntent",
    "formatTarget",
    "executionProfile",
    "artifactType",
    "writeTarget",
    "requiredSkill",
    "allowedTools",
    "allowedAppCliActions",
    "allowedOperateActions",
    "allowedWriteTargets",
    "saveSubdir",
    "deferredDiscovery",
    "teamEscalation",
    "sourcePlatform",
    "sourceNoteId",
    "sourceMode",
    "sourceTitle",
    "sourceManuscriptPath",
    "forceMultiAgent",
    "forceLongRunningTask",
    "requireTaskBrief",
    "requireSkillInvocations",
    "forbiddenFinalPhrases",
];

pub(in crate::commands::chat) fn clear_stale_task_hints_from_metadata(
    metadata: &Value,
) -> Option<Value> {
    let mut metadata_object = metadata.as_object()?.clone();
    let mut changed = false;
    for field in TASK_SCOPED_METADATA_FIELDS {
        changed |= metadata_object.remove(*field).is_some();
    }
    changed.then(|| Value::Object(metadata_object))
}

#[cfg(test)]
mod tests {
    use super::clear_stale_task_hints_from_metadata;
    use serde_json::json;

    #[test]
    fn clears_task_scoped_metadata_without_dropping_session_context() {
        let metadata = json!({
            "contextType": "redclaw",
            "initialContext": "space bootstrap",
            "taskBrief": {
                "goal": "write"
            },
            "taskHints": {
                "intent": "manuscript_creation",
                "requireProfileRead": true,
                "requireSourceRead": true,
                "requireSave": true,
                "requireTaskBrief": true,
                "requireSkillInvocations": ["xhs-title"],
                "forbiddenFinalPhrases": ["评论区"]
            },
            "intent": "manuscript_creation",
            "platform": "xiaohongshu",
            "taskType": "direct_write",
            "taskIntent": "video",
            "formatTarget": "markdown",
            "executionProfile": "artifact-authoring",
            "artifactType": "manuscript",
            "writeTarget": "manuscripts://current",
            "requiredSkill": "writing-style",
            "allowedTools": ["resource", "workflow"],
            "allowedAppCliActions": ["manuscripts.writeCurrent"],
            "allowedOperateActions": ["skills.invoke", "manuscripts.createProject"],
            "allowedWriteTargets": ["manuscripts://current"],
            "saveSubdir": "wander",
            "deferredDiscovery": false,
            "teamEscalation": "disabled",
            "sourcePlatform": "xiaohongshu",
            "sourceNoteId": "note-1",
            "sourceMode": "knowledge",
            "sourceTitle": "source",
            "sourceManuscriptPath": "wander/source",
            "forceMultiAgent": true,
            "forceLongRunningTask": true,
            "requireTaskBrief": true,
            "requireSkillInvocations": ["xhs-title"],
            "forbiddenFinalPhrases": ["评论区"],
            "currentAuthoringProjectPath": "wander/demo"
        });

        let cleaned = clear_stale_task_hints_from_metadata(&metadata).expect("cleaned metadata");

        for field in [
            "taskHints",
            "taskBrief",
            "intent",
            "platform",
            "taskType",
            "taskIntent",
            "formatTarget",
            "executionProfile",
            "artifactType",
            "writeTarget",
            "requiredSkill",
            "allowedTools",
            "allowedAppCliActions",
            "allowedOperateActions",
            "allowedWriteTargets",
            "saveSubdir",
            "deferredDiscovery",
            "teamEscalation",
            "sourcePlatform",
            "sourceNoteId",
            "sourceMode",
            "sourceTitle",
            "sourceManuscriptPath",
            "forceMultiAgent",
            "forceLongRunningTask",
            "requireTaskBrief",
            "requireSkillInvocations",
            "forbiddenFinalPhrases",
        ] {
            assert!(cleaned.get(field).is_none(), "{field} should be cleared");
        }
        assert_eq!(cleaned.get("contextType"), Some(&json!("redclaw")));
        assert_eq!(
            cleaned.get("initialContext"),
            Some(&json!("space bootstrap"))
        );
        assert_eq!(
            cleaned.get("currentAuthoringProjectPath"),
            Some(&json!("wander/demo"))
        );
    }

    #[test]
    fn leaves_metadata_unchanged_when_no_task_fields_exist() {
        let metadata = json!({
            "contextType": "redclaw",
            "initialContext": "space bootstrap"
        });

        assert!(clear_stale_task_hints_from_metadata(&metadata).is_none());
    }
}
