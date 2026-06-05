use crate::{normalize_optional_string, redbox_prompt_library_roots};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdvisorTemplateRecord {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    avatar: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    personality: String,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    knowledge_language: Option<String>,
}

fn advisor_template_roots() -> Vec<std::path::PathBuf> {
    redbox_prompt_library_roots()
        .into_iter()
        .map(|root| root.join("runtime").join("advisors").join("templates"))
        .filter(|path| path.exists() && path.is_dir())
        .collect()
}

fn normalize_advisor_template(
    template: AdvisorTemplateRecord,
    fallback_id: &str,
) -> AdvisorTemplateRecord {
    let normalized_id =
        normalize_optional_string(Some(template.id)).unwrap_or_else(|| fallback_id.to_string());
    let normalized_name =
        normalize_optional_string(Some(template.name)).unwrap_or_else(|| normalized_id.clone());

    AdvisorTemplateRecord {
        id: normalized_id,
        name: normalized_name,
        avatar: normalize_optional_string(Some(template.avatar))
            .unwrap_or_else(|| "🧠".to_string()),
        description: normalize_optional_string(Some(template.description)).unwrap_or_default(),
        category: normalize_optional_string(Some(template.category)).unwrap_or_default(),
        tags: template
            .tags
            .into_iter()
            .filter_map(|item| normalize_optional_string(Some(item)))
            .collect(),
        personality: normalize_optional_string(Some(template.personality)).unwrap_or_default(),
        system_prompt: normalize_optional_string(Some(template.system_prompt)).unwrap_or_default(),
        knowledge_language: normalize_optional_string(template.knowledge_language),
    }
}

pub(crate) fn advisors_list_templates_value() -> Result<Value, String> {
    let mut templates_by_id = BTreeMap::new();

    for root in advisor_template_roots() {
        let entries = fs::read_dir(&root).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }

            let content = fs::read_to_string(&path)
                .map_err(|error| format!("读取模板失败 {}: {error}", path.display()))?;
            let parsed: AdvisorTemplateRecord = serde_json::from_str(&content)
                .map_err(|error| format!("模板格式无效 {}: {error}", path.display()))?;
            let fallback_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("advisor-template");
            let normalized = normalize_advisor_template(parsed, fallback_id);
            templates_by_id.insert(normalized.id.clone(), normalized);
        }
    }

    let mut templates: Vec<_> = templates_by_id.into_values().collect();
    templates.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(json!(templates))
}
