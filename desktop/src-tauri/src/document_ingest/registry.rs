use crate::knowledge::{self, KnowledgeSourceInput};
use crate::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};

fn default_allow_update() -> bool {
    true
}

fn default_copy_into_workspace() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentSourceOptionsInput {
    #[serde(default = "default_copy_into_workspace")]
    pub copy_into_workspace: bool,
    #[serde(default = "default_allow_update")]
    pub allow_update: bool,
}

impl Default for KnowledgeDocumentSourceOptionsInput {
    fn default() -> Self {
        Self {
            copy_into_workspace: true,
            allow_update: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct KnowledgeDocumentSourceIngestRequest {
    pub space_id: Option<String>,
    pub kind: String,
    pub source: KnowledgeSourceInput,
    pub name: Option<String>,
    pub paths: Vec<String>,
    pub root_path: Option<String>,
    pub options: KnowledgeDocumentSourceOptionsInput,
}

fn collect_document_paths(request: &KnowledgeDocumentSourceIngestRequest) -> Vec<PathBuf> {
    let mut paths = request
        .paths
        .iter()
        .filter_map(|item| knowledge::normalize_string(Some(item.clone())).map(PathBuf::from))
        .collect::<Vec<_>>();
    if let Some(root_path) = knowledge::normalize_string(request.root_path.clone()) {
        let root = PathBuf::from(root_path);
        if root.is_file() {
            paths.push(root);
        }
    }
    paths
}

pub(crate) fn ingest_document_source(
    app: Option<&AppHandle>,
    state: &State<'_, AppState>,
    request: &KnowledgeDocumentSourceIngestRequest,
) -> Result<Value, String> {
    let app = app.ok_or_else(|| "document source ingestion 缺少 app handle".to_string())?;
    let _ = knowledge::ensure_supported_space(state, request.space_id.as_deref())?;
    let kind = request.kind.trim();
    if kind.is_empty() {
        return Err("document source kind 不能为空".to_string());
    }
    let name = knowledge::normalize_string(request.name.clone()).unwrap_or_else(|| match kind {
        "tracked-folder" => "Tracked Folder".to_string(),
        "obsidian-vault" => "Obsidian Vault".to_string(),
        _ => "Imported Files".to_string(),
    });
    match kind {
        "copied-file" => {
            if !request.options.copy_into_workspace {
                return Err("copied-file 当前必须 copyIntoWorkspace=true".to_string());
            }
            let files = collect_document_paths(request);
            if files.is_empty() {
                return Err("copied-file 需要至少一个有效文件路径".to_string());
            }
            let source_id = make_id("doc-source");
            let batch_root = knowledge::imported_docs_root(state)?.join(&source_id);
            fs::create_dir_all(&batch_root).map_err(|error| error.to_string())?;
            for file in &files {
                let _ = copy_file_into_dir(file, &batch_root)?;
            }
            knowledge::add_document_source(app, state, kind, &batch_root, &name, true)
        }
        "tracked-folder" | "obsidian-vault" => {
            let root = knowledge::normalize_string(request.root_path.clone())
                .map(PathBuf::from)
                .or_else(|| {
                    request.paths.first().and_then(|path| {
                        knowledge::normalize_string(Some(path.clone())).map(PathBuf::from)
                    })
                })
                .ok_or_else(|| format!("{kind} 需要 rootPath"))?;
            if !root.exists() || !root.is_dir() {
                return Err(format!("文档源目录不存在: {}", root.display()));
            }
            let response = knowledge::add_document_source(app, state, kind, &root, &name, false)?;
            Ok(json!({
                "success": response.get("success").and_then(|value| value.as_bool()).unwrap_or(false),
                "source": response.get("source").cloned().unwrap_or(Value::Null),
                "requestedOptions": {
                    "allowUpdate": request.options.allow_update,
                    "copyIntoWorkspace": request.options.copy_into_workspace,
                },
            }))
        }
        other => Err(format!("暂不支持的 document source kind: {other}")),
    }
}

pub(crate) fn import_document_files(
    app: &AppHandle,
    state: &State<'_, AppState>,
    files: &[PathBuf],
    display_name: &str,
) -> Result<Value, String> {
    let request = KnowledgeDocumentSourceIngestRequest {
        space_id: None,
        kind: "copied-file".to_string(),
        source: KnowledgeSourceInput {
            app_id: Some("redbox".to_string()),
            ..Default::default()
        },
        name: Some(display_name.to_string()),
        paths: files
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>(),
        root_path: None,
        options: KnowledgeDocumentSourceOptionsInput::default(),
    };
    ingest_document_source(Some(app), state, &request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_document_paths_includes_root_file() {
        let temp_file = std::env::temp_dir().join(format!(
            "redbox-document-ingest-test-{}.md",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp_file, "demo").unwrap();
        let request = KnowledgeDocumentSourceIngestRequest {
            root_path: Some(temp_file.display().to_string()),
            ..Default::default()
        };
        let paths = collect_document_paths(&request);
        assert_eq!(paths, vec![temp_file.clone()]);
        let _ = std::fs::remove_file(temp_file);
    }
}
