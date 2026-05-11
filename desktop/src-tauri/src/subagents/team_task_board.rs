use serde_json::Value;

use crate::AppStore;
use crate::runtime::{CollabTaskRecord, create_collab_task, list_collab_tasks, update_collab_task};

pub fn team_task_create(store: &mut AppStore, payload: &Value) -> Result<CollabTaskRecord, String> {
    create_collab_task(store, payload)
}

pub fn team_task_update(store: &mut AppStore, payload: &Value) -> Result<CollabTaskRecord, String> {
    update_collab_task(store, payload)
}

pub fn team_task_list(store: &AppStore, session_id: &str) -> Vec<CollabTaskRecord> {
    list_collab_tasks(store, session_id)
}

pub fn team_task_move(
    store: &mut AppStore,
    task_id: &str,
    status: &str,
) -> Result<CollabTaskRecord, String> {
    update_collab_task(
        store,
        &serde_json::json!({
            "taskId": task_id,
            "status": status
        }),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runtime::{add_collab_member, create_collab_session};

    #[test]
    fn reviewer_cannot_be_same_as_owner() {
        let mut store = AppStore::default();
        let session = create_collab_session(&mut store, &json!({ "objective": "review" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "作者" }),
        )
        .unwrap();

        let result = team_task_create(
            &mut store,
            &json!({
                "sessionId": session.id,
                "memberId": member.id,
                "reviewerMemberId": member.id,
                "title": "写稿"
            }),
        );

        assert!(result.is_err());
    }
}
