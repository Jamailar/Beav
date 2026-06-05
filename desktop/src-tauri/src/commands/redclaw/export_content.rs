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

fn value_string_list(value: Option<&Value>) -> Vec<String> {
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

fn first_string_field(value: &Value, keys: &[&str]) -> Option<String> {
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

fn markdown_list(items: &[String], empty: &str) -> String {
    if items.is_empty() {
        format!("- {empty}\n")
    } else {
        items
            .iter()
            .map(|item| format!("- {item}\n"))
            .collect::<String>()
    }
}

pub(super) fn build_publish_package_markdown(package: &Value) -> String {
    let titles = value_string_list(package.get("titleOptions"));
    let covers = value_string_list(package.get("coverOptions"));
    let hashtags = value_string_list(package.get("hashtags"));
    let checklist = value_string_list(package.get("checklist"));
    let body = package
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let project = package.get("project").cloned().unwrap_or_else(|| json!({}));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw Publish Package\n\n");
    markdown.push_str(&format!(
        "Project: `{}`\n\n",
        project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    ));
    markdown.push_str("## Titles\n\n");
    markdown.push_str(&markdown_list(&titles, "No title options generated."));
    markdown.push_str("\n## Cover Copy\n\n");
    markdown.push_str(&markdown_list(&covers, "No cover copy generated."));
    markdown.push_str("\n## Body\n\n");
    markdown.push_str(if body.is_empty() {
        "No body generated."
    } else {
        body
    });
    markdown.push_str("\n\n## Hashtags\n\n");
    markdown.push_str(&markdown_list(&hashtags, "No hashtags generated."));
    markdown.push_str("\n## Checklist\n\n");
    markdown.push_str(&markdown_list(&checklist, "No checklist generated."));
    markdown
}

pub(super) fn build_cover_brief_markdown(package: &Value) -> String {
    let titles = value_string_list(package.get("titleOptions"));
    let covers = value_string_list(package.get("coverOptions"));
    let project = package.get("project").cloned().unwrap_or_else(|| json!({}));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw Cover Brief\n\n");
    markdown.push_str(&format!(
        "Platform: {}\n\n",
        project
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("auto")
    ));
    markdown.push_str("## Primary Title Candidates\n\n");
    markdown.push_str(&markdown_list(&titles, "No title options generated."));
    markdown.push_str("\n## Cover Text Candidates\n\n");
    markdown.push_str(&markdown_list(&covers, "No cover copy generated."));
    markdown.push_str("\n## Visual Direction\n\nUse the creator profile, platform fit, and selected title to generate a clean cover image. Keep text legible on mobile.\n");
    markdown
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

fn markdown_json_block(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

pub(super) fn build_review_report_markdown(report: &Value) -> String {
    let issues = value_string_list(report.get("blockingIssues"));
    let summary = report
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let project = report.get("project").cloned().unwrap_or_else(|| json!({}));
    let quality_score = report.get("qualityScore").cloned().unwrap_or(Value::Null);
    let suggested_patches = report
        .get("suggestedPatches")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let learning_candidates = report
        .get("learningCandidates")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw Review Report\n\n");
    markdown.push_str(&format!(
        "Project: `{}`\n\n",
        project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    ));
    markdown.push_str("## Summary\n\n");
    markdown.push_str(if summary.is_empty() {
        "No review summary generated."
    } else {
        summary
    });
    markdown.push_str("\n\n## Quality Score\n\n```json\n");
    markdown.push_str(&markdown_json_block(&quality_score));
    markdown.push_str("\n```\n\n## Blocking Issues\n\n");
    markdown.push_str(&markdown_list(&issues, "No blocking issues generated."));
    markdown.push_str("\n## Suggested Patches\n\n```json\n");
    markdown.push_str(&markdown_json_block(&suggested_patches));
    markdown.push_str("\n```\n\n## Learning Candidates\n\n```json\n");
    markdown.push_str(&markdown_json_block(&learning_candidates));
    markdown.push_str("\n```\n");
    markdown
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

fn xhs_copy_titles(package: &Value) -> Vec<String> {
    value_string_list(
        package
            .get("copyPackage")
            .and_then(|copy| copy.get("titles"))
            .or_else(|| {
                package
                    .get("publishPackage")
                    .and_then(|publish| publish.get("titleOptions"))
            }),
    )
}

pub(super) fn build_xhs_package_markdown(package: &Value) -> String {
    let titles = xhs_copy_titles(package);
    let copy = package
        .get("copyPackage")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let body = first_string_field(&copy, &["body", "正文"]).unwrap_or_default();
    let cover_title = first_string_field(&copy, &["coverTitle", "cover_title"]).unwrap_or_default();
    let hashtags = value_string_list(copy.get("hashtags").or_else(|| {
        package
            .get("publishPackage")
            .and_then(|publish| publish.get("hashtags"))
    }));
    let project = package.get("project").cloned().unwrap_or_else(|| json!({}));
    let layout = package
        .get("carouselLayout")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let images = package
        .get("imageAssets")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let compliance = package
        .get("complianceReport")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let deterministic_compliance = package
        .get("deterministicCompliance")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut markdown = String::new();
    markdown.push_str("# RedClaw XHS Package\n\n");
    markdown.push_str(&format!(
        "Project: `{}`\n\n",
        project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    ));
    markdown.push_str("## Titles\n\n");
    markdown.push_str(&markdown_list(&titles, "No title options generated."));
    markdown.push_str("\n## Cover Title\n\n");
    markdown.push_str(if cover_title.is_empty() {
        "No cover title generated."
    } else {
        &cover_title
    });
    markdown.push_str("\n\n## Body\n\n");
    markdown.push_str(if body.is_empty() {
        "No body generated."
    } else {
        &body
    });
    markdown.push_str("\n\n## Hashtags\n\n");
    markdown.push_str(&markdown_list(&hashtags, "No hashtags generated."));
    markdown.push_str("\n## Carousel Layout\n\n```json\n");
    markdown.push_str(&markdown_json_block(&layout));
    markdown.push_str("\n```\n\n## Image Assets\n\n```json\n");
    markdown.push_str(&markdown_json_block(&images));
    markdown.push_str("\n```\n\n## Compliance\n\n```json\n");
    markdown.push_str(&markdown_json_block(&compliance));
    markdown.push_str("\n```\n\n## Deterministic Compliance\n\n```json\n");
    markdown.push_str(&markdown_json_block(&deterministic_compliance));
    markdown.push_str("\n```\n");
    markdown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_package_markdown_includes_titles_body_and_cover_copy() {
        let package = json!({
            "schema": "redclaw.publishPackage.v1",
            "project": { "id": "project-1", "platform": "xiaohongshu" },
            "titleOptions": ["Title A", "Title B"],
            "coverOptions": ["Cover line"],
            "body": "Post body",
            "hashtags": ["#redclaw"],
            "checklist": ["Fact checked"]
        });
        let markdown = build_publish_package_markdown(&package);
        let cover = build_cover_brief_markdown(&package);

        assert!(markdown.contains("Title A"));
        assert!(markdown.contains("Cover line"));
        assert!(markdown.contains("Post body"));
        assert!(markdown.contains("#redclaw"));
        assert!(cover.contains("Cover line"));
        assert!(cover.contains("Platform: xiaohongshu"));
    }

    #[test]
    fn review_report_markdown_includes_score_issues_and_learnings() {
        let report = json!({
            "schema": "redclaw.reviewReport.v1",
            "project": { "id": "project-1" },
            "summary": "Ready after one patch",
            "qualityScore": { "overall": 82, "platformFit": 90 },
            "blockingIssues": ["Missing source citation"],
            "suggestedPatches": [{ "sectionId": "script", "reason": "Add citation" }],
            "learningCandidates": [{ "statement": "Prefer stronger source links" }]
        });
        let markdown = build_review_report_markdown(&report);

        assert!(markdown.contains("Ready after one patch"));
        assert!(markdown.contains("Missing source citation"));
        assert!(markdown.contains("\"overall\": 82"));
        assert!(markdown.contains("Prefer stronger source links"));
    }

    #[test]
    fn xhs_package_markdown_includes_copy_layout_and_compliance() {
        let package = json!({
            "schema": "redclaw.xhsPackage.v1",
            "project": { "id": "project-1", "platform": "xiaohongshu" },
            "copyPackage": {
                "titles": ["Title A"],
                "coverTitle": "Cover A",
                "body": "XHS body",
                "hashtags": ["#xhs"]
            },
            "carouselLayout": {
                "aspectRatio": "3:4",
                "pages": [{ "index": 1, "role": "cover", "headline": "Cover A", "layout": "title_card" }]
            },
            "imageAssets": {
                "pages": [{ "index": 1, "path": "/tmp/cover.png", "source": "generated" }],
                "missingAssets": []
            },
            "complianceReport": {
                "riskLevel": "low",
                "approved": true
            },
            "deterministicCompliance": {
                "schema": "redclaw.xhsDeterministicCompliance.v1",
                "riskLevel": "low",
                "approved": true
            }
        });
        let markdown = build_xhs_package_markdown(&package);

        assert!(markdown.contains("Title A"));
        assert!(markdown.contains("Cover A"));
        assert!(markdown.contains("XHS body"));
        assert!(markdown.contains("aspectRatio"));
        assert!(markdown.contains("riskLevel"));
        assert!(markdown.contains("redclaw.xhsDeterministicCompliance.v1"));
    }

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
