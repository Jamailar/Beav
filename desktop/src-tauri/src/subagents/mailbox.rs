use serde_json::Value;

use crate::runtime::{
    cleanup_collab_mailbox, list_collab_messages, post_collab_message, read_collab_mailbox,
    request_collab_report, CollabMailboxMessageRecord,
};
use crate::AppStore;

pub fn team_mailbox_send(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMailboxMessageRecord, String> {
    post_collab_message(store, payload)
}

pub fn team_mailbox_request_report(
    store: &mut AppStore,
    payload: &Value,
) -> Result<CollabMailboxMessageRecord, String> {
    request_collab_report(store, payload)
}

pub fn team_mailbox_read(
    store: &mut AppStore,
    payload: &Value,
) -> Result<Vec<CollabMailboxMessageRecord>, String> {
    read_collab_mailbox(store, payload)
}

pub fn team_mailbox_history(
    store: &AppStore,
    session_id: &str,
    member_id: Option<&str>,
    task_id: Option<&str>,
    limit: Option<usize>,
) -> Vec<CollabMailboxMessageRecord> {
    list_collab_messages(store, session_id, member_id, task_id, false, limit)
}

pub fn team_mailbox_cleanup(
    store: &mut AppStore,
    session_id: &str,
    keep_latest_read: usize,
) -> usize {
    cleanup_collab_mailbox(store, session_id, keep_latest_read)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runtime::{add_collab_member, create_collab_session};

    #[test]
    fn mailbox_read_marks_messages_read_once() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "mailbox" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "成员" }),
        )
        .unwrap();
        team_mailbox_send(
            &mut store,
            &json!({
                "sessionId": session.id,
                "toMemberId": member.id,
                "body": "请处理"
            }),
        )
        .unwrap();

        let first = team_mailbox_read(
            &mut store,
            &json!({ "sessionId": session.id, "memberId": member.id }),
        )
        .unwrap();
        let second = team_mailbox_read(
            &mut store,
            &json!({ "sessionId": session.id, "memberId": member.id }),
        )
        .unwrap();

        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
        assert!(store.collab_mailbox_messages[0].read_at.is_some());
    }
}
