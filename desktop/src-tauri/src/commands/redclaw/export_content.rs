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

fn xhs_text_sources_for_compliance(package: &Value) -> Vec<(String, String)> {
    let mut sources = Vec::new();
    if let Some(copy) = package.get("copyPackage") {
        for title in value_string_list(copy.get("titles")) {
            sources.push(("title".to_string(), title));
        }
        for key in ["coverTitle", "openingHook", "body", "cta", "commentPrompt"] {
            if let Some(value) = copy
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                sources.push((key.to_string(), value.to_string()));
            }
        }
    }
    if let Some(publish) = package.get("publishPackage") {
        for title in value_string_list(publish.get("titleOptions")) {
            sources.push(("publishTitle".to_string(), title));
        }
        for key in ["body", "caption", "postBody"] {
            if let Some(value) = publish
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                sources.push((format!("publish.{key}"), value.to_string()));
            }
        }
    }
    sources
}

fn contains_any_term(text: &str, terms: &[&str]) -> Vec<String> {
    terms
        .iter()
        .filter(|term| text.contains(**term))
        .map(|term| term.to_string())
        .collect()
}

fn deterministic_xhs_compliance(package: &Value) -> Value {
    let absolute_terms = [
        "最强",
        "最佳",
        "最好",
        "最全",
        "最高",
        "第一",
        "顶级",
        "唯一",
        "永久",
        "100%",
        "百分百",
        "保证",
        "必看",
    ];
    let medical_terms = ["治愈", "根治", "疗效", "药到病除", "无副作用"];
    let finance_terms = ["稳赚", "保本", "暴富", "翻倍收益", "稳赚不赔"];
    let legal_terms = ["合法保证", "绝对合规", "零风险"];
    let commercial_terms = ["广告", "赞助", "合作", "佣金"];
    let mut sensitive_terms = Vec::<Value>::new();
    let mut blocking_issues = Vec::<Value>::new();
    let mut suggested_rewrites = Vec::<Value>::new();

    for (field, text) in xhs_text_sources_for_compliance(package) {
        let mut field_terms = Vec::new();
        for term in contains_any_term(&text, &absolute_terms) {
            field_terms.push(term.clone());
            suggested_rewrites.push(json!({
                "field": field,
                "term": term,
                "suggestion": "Replace absolute wording with evidence-backed, conditional wording."
            }));
        }
        for term in contains_any_term(&text, &medical_terms) {
            field_terms.push(term.clone());
            blocking_issues.push(json!({
                "field": field,
                "term": term,
                "risk": "medical_claim",
                "message": "Medical efficacy claims need evidence and careful wording before publishing."
            }));
        }
        for term in contains_any_term(&text, &finance_terms) {
            field_terms.push(term.clone());
            blocking_issues.push(json!({
                "field": field,
                "term": term,
                "risk": "financial_claim",
                "message": "Financial return guarantees are high-risk and should be rewritten."
            }));
        }
        for term in contains_any_term(&text, &legal_terms) {
            field_terms.push(term.clone());
            blocking_issues.push(json!({
                "field": field,
                "term": term,
                "risk": "legal_claim",
                "message": "Legal certainty claims are high-risk and should be rewritten."
            }));
        }
        for term in contains_any_term(&text, &commercial_terms) {
            field_terms.push(term.clone());
            suggested_rewrites.push(json!({
                "field": field,
                "term": term,
                "suggestion": "If this is commercial content, keep disclosure explicit and platform-compliant."
            }));
        }
        for term in field_terms {
            sensitive_terms.push(json!({ "field": field, "term": term }));
        }
    }
    let risk_level = if !blocking_issues.is_empty() {
        "high"
    } else if !sensitive_terms.is_empty() {
        "medium"
    } else {
        "low"
    };
    json!({
        "schema": "redclaw.xhsDeterministicCompliance.v1",
        "riskLevel": risk_level,
        "approved": blocking_issues.is_empty(),
        "sensitiveTerms": sensitive_terms,
        "blockingIssues": blocking_issues,
        "suggestedRewrites": suggested_rewrites,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_xhs_compliance_flags_high_risk_terms() {
        let package = json!({
            "schema": "redclaw.xhsPackage.v1",
            "copyPackage": {
                "titles": ["7天治愈焦虑的最好方法"],
                "body": "这个方法保证有效，稳赚不赔。"
            }
        });

        let report = deterministic_xhs_compliance(&package);

        assert_eq!(
            report.get("riskLevel").and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(report.get("approved").and_then(Value::as_bool), Some(false));
        assert!(report
            .get("blockingIssues")
            .and_then(Value::as_array)
            .is_some_and(|items| items
                .iter()
                .any(|item| item.get("term").and_then(Value::as_str) == Some("治愈"))));
        assert!(report
            .get("suggestedRewrites")
            .and_then(Value::as_array)
            .is_some_and(|items| items
                .iter()
                .any(|item| item.get("term").and_then(Value::as_str) == Some("最好"))));
    }
}
