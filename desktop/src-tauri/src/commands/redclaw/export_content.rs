use super::xhs_compliance::deterministic_xhs_compliance;
use super::*;

pub(super) fn output_for_role(outputs: &[Value], role_id: &str) -> Option<Value> {
    outputs
        .iter()
        .find(|item| item.get("roleId").and_then(Value::as_str) == Some(role_id))
        .cloned()
}

pub(super) fn parsed_output_artifact(output: Option<&Value>) -> Value {
    let Some(output) = output else {
        return Value::Null;
    };
    let artifact = output
        .get("artifact")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if artifact.is_empty() {
        return Value::Null;
    }
    parse_json_value_from_text(artifact).unwrap_or_else(|| json!({ "raw": artifact }))
}

pub(super) fn redclaw_output_summary(output: Option<&Value>) -> Value {
    let Some(output) = output else {
        return Value::Null;
    };
    json!({
        "roleId": output.get("roleId").cloned().unwrap_or(Value::Null),
        "summary": output.get("summary").cloned().unwrap_or(Value::Null),
        "artifact": output.get("artifact").cloned().unwrap_or(Value::Null),
        "handoff": output.get("handoff").cloned().unwrap_or(Value::Null),
        "risks": output.get("risks").cloned().unwrap_or_else(|| json!([])),
        "issues": output.get("issues").cloned().unwrap_or_else(|| json!([])),
    })
}

pub(super) fn orchestration_outputs_for_project(
    project: &crate::runtime::RedclawProjectRecord,
) -> Vec<Value> {
    project
        .metadata
        .as_ref()
        .and_then(|value| value.get("orchestrationOutputs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn value_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToString::to_string)
                .or_else(|| {
                    if item.is_object() {
                        Some(item.to_string())
                    } else {
                        None
                    }
                })
        })
        .collect()
}

pub(super) fn first_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

pub(super) fn publish_package_from_project(
    project: &crate::runtime::RedclawProjectRecord,
) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let publish = output_for_role(&outputs, "publish_agent");
    let publish_artifact = parsed_output_artifact(publish.as_ref());
    let raw_artifact = publish
        .as_ref()
        .and_then(|value| value.get("artifact"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let title_options = publish_artifact
        .get("titleOptions")
        .or_else(|| publish_artifact.get("titles"))
        .or_else(|| publish_artifact.get("title_options"));
    let cover_options = publish_artifact
        .get("coverOptions")
        .or_else(|| publish_artifact.get("coverCopy"))
        .or_else(|| publish_artifact.get("cover"))
        .or_else(|| publish_artifact.get("cover_options"));
    let body = first_string_field(
        &publish_artifact,
        &["body", "caption", "postBody", "正文", "copy"],
    )
    .or_else(|| {
        publish
            .as_ref()
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
    .unwrap_or_else(|| raw_artifact.to_string());
    json!({
        "schema": "redclaw.publishPackage.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
        },
        "generatedAt": now_iso(),
        "titleOptions": value_string_list(title_options),
        "coverOptions": value_string_list(cover_options),
        "body": body,
        "hashtags": value_string_list(
            publish_artifact.get("hashtags")
                .or_else(|| publish_artifact.get("tags"))
        ),
        "checklist": value_string_list(publish_artifact.get("checklist")),
        "raw": publish_artifact,
        "source": redclaw_output_summary(publish.as_ref()),
    })
}

pub(super) fn review_report_from_project(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let editor = output_for_role(&outputs, "editor_agent");
    let review = output_for_role(&outputs, "review_agent");
    let review_artifact = parsed_output_artifact(review.as_ref());
    let quality_score = review_artifact
        .get("qualityScore")
        .or_else(|| review_artifact.get("score"))
        .cloned()
        .unwrap_or(Value::Null);
    let blocking_issues = value_string_list(
        review_artifact
            .get("blockingIssues")
            .or_else(|| review_artifact.get("issues"))
            .or_else(|| review.as_ref().and_then(|value| value.get("issues"))),
    );
    let suggested_patches = review_artifact
        .get("suggestedPatches")
        .or_else(|| review_artifact.get("patches"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let learning_candidates = review
        .as_ref()
        .and_then(|value| value.get("learningCandidates"))
        .or_else(|| review_artifact.get("learningCandidates"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let summary = first_string_field(
        &review_artifact,
        &["summary", "conclusion", "overall", "reviewSummary"],
    )
    .or_else(|| {
        review
            .as_ref()
            .and_then(|value| value.get("summary"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
    .unwrap_or_default();
    json!({
        "schema": "redclaw.reviewReport.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
        },
        "generatedAt": now_iso(),
        "summary": summary,
        "qualityScore": quality_score,
        "blockingIssues": blocking_issues,
        "suggestedPatches": suggested_patches,
        "learningCandidates": learning_candidates,
        "sources": {
            "editor": redclaw_output_summary(editor.as_ref()),
            "review": redclaw_output_summary(review.as_ref()),
        },
        "raw": review_artifact,
    })
}

fn artifact_for_role(outputs: &[Value], role_id: &str) -> Value {
    parsed_output_artifact(output_for_role(outputs, role_id).as_ref())
}

pub(super) fn xhs_package_from_project(project: &crate::runtime::RedclawProjectRecord) -> Value {
    let outputs = orchestration_outputs_for_project(project);
    let topic = artifact_for_role(&outputs, "topic_agent");
    let architecture = artifact_for_role(&outputs, "note_architect_agent");
    let copy = artifact_for_role(&outputs, "copy_agent");
    let visual = artifact_for_role(&outputs, "visual_director_agent");
    let images = artifact_for_role(&outputs, "image_agent");
    let layout = artifact_for_role(&outputs, "layout_agent");
    let compliance = artifact_for_role(&outputs, "compliance_agent");
    let publish = publish_package_from_project(project);
    let review = review_report_from_project(project);
    let mut package = json!({
        "schema": "redclaw.xhsPackage.v1",
        "project": {
            "id": project.id,
            "goal": project.goal,
            "platform": project.platform,
            "contentFormat": project.content_format,
            "runtimeTaskId": project.runtime_task_id,
        },
        "generatedAt": now_iso(),
        "topic": topic,
        "noteArchitecture": architecture,
        "copyPackage": copy,
        "visualBrief": visual,
        "imageAssets": images,
        "carouselLayout": layout,
        "publishPackage": publish,
        "complianceReport": compliance,
        "reviewReport": review,
        "sources": {
            "topic": redclaw_output_summary(output_for_role(&outputs, "topic_agent").as_ref()),
            "noteArchitecture": redclaw_output_summary(output_for_role(&outputs, "note_architect_agent").as_ref()),
            "copy": redclaw_output_summary(output_for_role(&outputs, "copy_agent").as_ref()),
            "visual": redclaw_output_summary(output_for_role(&outputs, "visual_director_agent").as_ref()),
            "image": redclaw_output_summary(output_for_role(&outputs, "image_agent").as_ref()),
            "layout": redclaw_output_summary(output_for_role(&outputs, "layout_agent").as_ref()),
            "compliance": redclaw_output_summary(output_for_role(&outputs, "compliance_agent").as_ref())
        }
    });
    let deterministic_compliance = deterministic_xhs_compliance(&package);
    if let Some(object) = package.as_object_mut() {
        object.insert(
            "deterministicCompliance".to_string(),
            deterministic_compliance,
        );
    }
    package
}
