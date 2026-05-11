use serde_json::Value;

use crate::AppStore;
use crate::runtime::{
    CollabMailboxMessageRecord, cleanup_collab_mailbox, list_collab_messages, post_collab_message,
    read_collab_mailbox, request_collab_report,
};

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
    use crate::now_i64;
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

    #[test]
    fn mailbox_cleanup_keeps_recent_read_latest_read_and_unread_messages() {
        let mut store = AppStore::default();
        let session =
            create_collab_session(&mut store, &json!({ "objective": "mailbox cleanup" })).unwrap();
        let member = add_collab_member(
            &mut store,
            &json!({ "sessionId": session.id, "displayName": "成员" }),
        )
        .unwrap();

        for body in [
            "recent-read",
            "old-latest-read",
            "old-delete-read",
            "old-unread",
        ] {
            team_mailbox_send(
                &mut store,
                &json!({
                    "sessionId": session.id,
                    "toMemberId": member.id,
                    "body": body
                }),
            )
            .unwrap();
        }
        team_mailbox_read(
            &mut store,
            &json!({ "sessionId": session.id, "memberId": member.id, "limit": 3 }),
        )
        .unwrap();

        let now = now_i64();
        for message in store.collab_mailbox_messages.iter_mut() {
            match message.body.as_str() {
                "recent-read" => {
                    message.created_at = now - 24 * 60 * 60 * 1000;
                    message.read_at = Some(now - 24 * 60 * 60 * 1000);
                }
                "old-latest-read" => {
                    message.created_at = now - 8 * 24 * 60 * 60 * 1000;
                    message.read_at = Some(now - 8 * 24 * 60 * 60 * 1000);
                }
                "old-delete-read" => {
                    message.created_at = now - 9 * 24 * 60 * 60 * 1000;
                    message.read_at = Some(now - 9 * 24 * 60 * 60 * 1000);
                }
                "old-unread" => {
                    message.created_at = now - 30 * 24 * 60 * 60 * 1000;
                    message.read_at = None;
                    message.status = "unread".to_string();
                }
                _ => {}
            }
        }

        let removed = team_mailbox_cleanup(&mut store, &session.id, 2);
        let remaining_bodies = store
            .collab_mailbox_messages
            .iter()
            .map(|message| message.body.as_str())
            .collect::<Vec<_>>();

        assert_eq!(removed, 1);
        assert!(remaining_bodies.contains(&"recent-read"));
        assert!(remaining_bodies.contains(&"old-latest-read"));
        assert!(remaining_bodies.contains(&"old-unread"));
        assert!(!remaining_bodies.contains(&"old-delete-read"));
    }
}
