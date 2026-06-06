use super::redclaw_export_content::value_string_list;
use serde_json::{json, Value};

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

pub(super) fn deterministic_xhs_compliance(package: &Value) -> Value {
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

#[cfg(test)]
mod tests {
    use super::deterministic_xhs_compliance;
    use serde_json::{json, Value};

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
