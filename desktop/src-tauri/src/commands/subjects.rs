use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::persistence::{ensure_store_hydrated_for_subjects, with_store};
use crate::{
    handle_subject_category_create, handle_subject_category_delete, handle_subject_category_update,
    handle_subject_create, handle_subject_delete, handle_subject_update, payload_string, AppState,
    SubjectRecord,
};

pub fn handle_subjects_channel(
    _app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "subjects:list" => {
            let _ = ensure_store_hydrated_for_subjects(state);
            with_store(state, |store| {
                Ok(json!({ "success": true, "subjects": store.subjects.clone() }))
            })
        }
        "subjects:get" => {
            let Some(id) = payload_string(payload, "id") else {
                return Some(Ok(json!({ "success": false, "error": "缺少主体 id" })));
            };
            with_store(state, |store| {
                let subject = store.subjects.iter().find(|item| item.id == id).cloned();
                Ok(json!({ "success": true, "subject": subject }))
            })
        }
        "subjects:create" => handle_subject_create(payload.clone(), state),
        "subjects:update" => handle_subject_update(payload.clone(), state),
        "subjects:delete" => handle_subject_delete(payload.clone(), state),
        "subjects:search" => {
            let query = payload_string(payload, "query")
                .unwrap_or_default()
                .to_lowercase();
            let category_id = payload_string(payload, "categoryId");
            with_store(state, |store| {
                let subjects: Vec<SubjectRecord> = store
                    .subjects
                    .iter()
                    .filter(|subject| {
                        let matches_category = match category_id.as_deref() {
                            Some(category) => subject.category_id.as_deref() == Some(category),
                            None => true,
                        };
                        let matches_query = if query.is_empty() {
                            true
                        } else {
                            let haystack = format!(
                                "{}\n{}\n{}",
                                subject.name,
                                subject.description.clone().unwrap_or_default(),
                                subject.tags.join(" ")
                            )
                            .to_lowercase();
                            haystack.contains(&query)
                        };
                        matches_category && matches_query
                    })
                    .cloned()
                    .collect();
                Ok(json!({ "success": true, "subjects": subjects }))
            })
        }
        "subjects:categories:list" => with_store(state, |store| {
            Ok(json!({ "success": true, "categories": store.categories.clone() }))
        }),
        "subjects:categories:create" => handle_subject_category_create(payload.clone(), state),
        "subjects:categories:update" => handle_subject_category_update(payload.clone(), state),
        "subjects:categories:delete" => handle_subject_category_delete(payload.clone(), state),
        _ => return None,
    };
    Some(result)
}
