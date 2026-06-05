use super::types::{AppStore, WorkItemRecord};

pub(crate) fn list_sorted(store: &AppStore) -> Vec<WorkItemRecord> {
    let mut items = store.work_items.clone();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items
}

pub(crate) fn list_ready_sorted(store: &AppStore) -> Vec<WorkItemRecord> {
    let mut items = store
        .work_items
        .iter()
        .filter(|item| item.effective_status == "ready" || item.effective_status == "pending")
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items
}

pub(crate) fn get_item(store: &AppStore, id: &str) -> Option<WorkItemRecord> {
    store.work_items.iter().find(|item| item.id == id).cloned()
}

pub(crate) fn extend_items(store: &mut AppStore, items: Vec<WorkItemRecord>) {
    store.work_items.extend(items);
}

pub(crate) fn update_item(
    store: &mut AppStore,
    id: &str,
    title: Option<String>,
    description: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    updated_at: &str,
) -> Option<WorkItemRecord> {
    let item = store.work_items.iter_mut().find(|entry| entry.id == id)?;
    if let Some(title) = title {
        item.title = title;
    }
    if let Some(description) = description {
        item.description = Some(description);
    }
    if let Some(summary) = summary {
        item.summary = Some(summary);
    }
    if let Some(status) = status {
        item.status = status.clone();
        item.effective_status = match status.as_str() {
            "pending" => "ready".to_string(),
            other => other.to_string(),
        };
        item.completed_at = if status == "done" {
            Some(updated_at.to_string())
        } else {
            None
        };
    }
    item.updated_at = updated_at.to_string();
    Some(item.clone())
}
