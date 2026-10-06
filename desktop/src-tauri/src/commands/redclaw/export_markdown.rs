use serde_json::{json, Value};

use super::redclaw_export_content::{first_string_field, value_string_list};

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

fn markdown_json_block(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
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
}
