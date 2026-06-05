use crate::member_skill::{
    compile_member_skill_package, discard_member_skill_candidate, evaluate_member_skill,
    inspect_member_skill_versions, mark_member_skill_failed, member_feature_flag_enabled_for_store,
    member_skill_result_value, promote_member_skill_candidate, publish_member_skill_for_advisor,
    rollback_member_skill_version,
};
use crate::persistence::with_store;
use crate::{payload_string, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

pub(super) fn member_skill_distillation_enabled(
    state: &State<'_, AppState>,
) -> Result<bool, String> {
    with_store(state, |store| {
        Ok(member_feature_flag_enabled_for_store(
            &store,
            "memberSkillDistillation",
            true,
        ))
    })
}

pub(super) fn publish_member_skill_if_enabled(
    state: &State<'_, AppState>,
    advisor_id: &str,
    source_event: &str,
) -> Option<Value> {
    match member_skill_distillation_enabled(state) {
        Ok(false) => Some(json!({
            "status": "fallback",
            "skipped": true,
            "reason": "memberSkillDistillation disabled"
        })),
        Ok(true) => match publish_member_skill_for_advisor(state, advisor_id, source_event) {
            Ok(result) => Some(member_skill_result_value(&result)),
            Err(error) => {
                let _ = mark_member_skill_failed(state, advisor_id, &error);
                Some(json!({ "status": "failed", "error": error }))
            }
        },
        Err(error) => Some(json!({ "status": "failed", "error": error })),
    }
}

pub(super) fn handle_member_skill_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "members:enqueue-distillation"
            | "members:distill-skill"
            | "advisors:promote-member-skill-candidate"
            | "members:approve-distillation"
            | "members:publish-skill-version"
            | "advisors:discard-member-skill-candidate"
            | "advisors:inspect-member-skill"
            | "members:list-distillation-candidates"
            | "members:preview-distillation"
            | "advisors:rollback-member-skill-version"
            | "members:rollback-skill-version"
            | "members:compile-skill-package"
            | "members:evaluate-skill"
    ) {
        return None;
    }
    Some(handle_known_member_skill_channel(
        app, state, channel, payload,
    ))
}

fn handle_known_member_skill_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Result<Value, String> {
    match channel {
        "members:enqueue-distillation" | "members:distill-skill" => {
            let advisor_id = advisor_id_from_payload(payload);
            let result = if member_skill_distillation_enabled(state)? {
                publish_member_skill_for_advisor(state, &advisor_id, "members:enqueue-distillation")
                    .map(|result| {
                        json!({ "success": true, "memberSkill": member_skill_result_value(&result) })
                    })
                    .unwrap_or_else(|error| {
                        let _ = mark_member_skill_failed(state, &advisor_id, &error);
                        json!({ "success": false, "error": error })
                    })
            } else {
                json!({
                    "success": false,
                    "error": "memberSkillDistillation disabled"
                })
            };
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:promote-member-skill-candidate"
        | "members:approve-distillation"
        | "members:publish-skill-version" => {
            let advisor_id = advisor_id_from_payload(payload);
            let candidate_version = payload_string(payload, "candidateVersion")
                .or_else(|| payload_string(payload, "version"));
            let result =
                promote_member_skill_candidate(state, &advisor_id, candidate_version.as_deref())
                    .map(|result| {
                        json!({ "success": true, "memberSkill": member_skill_result_value(&result) })
                    })
                    .unwrap_or_else(|error| json!({ "success": false, "error": error }));
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:discard-member-skill-candidate" => {
            let advisor_id = advisor_id_from_payload(payload);
            let result = discard_member_skill_candidate(state, &advisor_id)
                .map(|_| json!({ "success": true }))
                .unwrap_or_else(|error| json!({ "success": false, "error": error }));
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "advisors:inspect-member-skill"
        | "members:list-distillation-candidates"
        | "members:preview-distillation" => {
            let advisor_id = advisor_id_from_payload(payload);
            inspect_member_skill_versions(state, &advisor_id)
                .or_else(|error| Ok(json!({ "success": false, "error": error })))
        }
        "advisors:rollback-member-skill-version" | "members:rollback-skill-version" => {
            let advisor_id = advisor_id_from_payload(payload);
            let version = payload_string(payload, "version").unwrap_or_default();
            let result = rollback_member_skill_version(state, &advisor_id, &version)
                .map(|result| {
                    json!({ "success": true, "memberSkill": member_skill_result_value(&result) })
                })
                .unwrap_or_else(|error| json!({ "success": false, "error": error }));
            let _ = app.emit("advisors:changed", json!({ "advisorId": advisor_id }));
            Ok(result)
        }
        "members:compile-skill-package" => {
            let advisor_id = advisor_id_from_payload(payload);
            let version = payload_string(payload, "version");
            let candidate = payload
                .get("candidate")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || payload_string(payload, "target")
                    .map(|target| target == "candidate")
                    .unwrap_or(false);
            compile_member_skill_package(state, &advisor_id, version.as_deref(), candidate)
                .or_else(|error| Ok(json!({ "success": false, "error": error })))
        }
        "members:evaluate-skill" => {
            let advisor_id = advisor_id_from_payload(payload);
            evaluate_member_skill(state, &advisor_id)
                .or_else(|error| Ok(json!({ "success": false, "error": error })))
        }
        _ => Err("成员技能动作未注册".to_string()),
    }
}

fn advisor_id_from_payload(payload: &Value) -> String {
    payload_string(payload, "advisorId")
        .or_else(|| payload_string(payload, "id"))
        .unwrap_or_default()
}
