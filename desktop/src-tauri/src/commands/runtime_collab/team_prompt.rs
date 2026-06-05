use super::*;
use serde_json::Map;

fn member_metadata_object(member: &CollabMemberRecord) -> Map<String, Value> {
    member
        .metadata
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn team_member_session_metadata(
    store: &crate::AppStore,
    session: &CollabSessionRecord,
    member: &CollabMemberRecord,
) -> Value {
    let member_metadata = member_metadata_object(member);
    let advisor_id = member_metadata
        .get("advisorId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let advisor = advisor_id
        .as_ref()
        .and_then(|id| store.advisors.iter().find(|item| item.id == *id));

    let mut active_speaker = Map::new();
    active_speaker.insert("type".to_string(), json!("member"));
    active_speaker.insert("memberId".to_string(), json!(member.id));
    active_speaker.insert("displayName".to_string(), json!(member.display_name));
    active_speaker.insert("roleId".to_string(), json!(member.role_id));
    if let Some(advisor_id) = advisor_id.as_ref() {
        active_speaker.insert("speakerId".to_string(), json!(advisor_id));
        active_speaker.insert("memberId".to_string(), json!(advisor_id));
        active_speaker.insert("advisorId".to_string(), json!(advisor_id));
        active_speaker.insert("collabMemberId".to_string(), json!(member.id));
        active_speaker.insert(
            "knowledgeScope".to_string(),
            json!({
                "type": "advisor",
                "advisorId": advisor_id,
            }),
        );
    }
    if let Some(value) = member_metadata
        .get("avatar")
        .cloned()
        .or_else(|| advisor.map(|item| json!(item.avatar)))
    {
        active_speaker.insert("avatar".to_string(), value);
    }
    if let Some(value) = member_metadata
        .get("personality")
        .cloned()
        .or_else(|| advisor.map(|item| json!(item.personality)))
    {
        active_speaker.insert("personality".to_string(), value);
    }
    if let Some(value) = member_metadata
        .get("systemPrompt")
        .cloned()
        .or_else(|| advisor.map(|item| json!(item.system_prompt)))
    {
        active_speaker.insert("systemPrompt".to_string(), value);
    }

    let member_skill_ref = member_metadata
        .get("memberSkillRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| advisor.and_then(|item| item.member_skill_ref.clone()));

    let mut metadata = Map::new();
    metadata.insert("contextType".to_string(), json!("team"));
    metadata.insert("contextId".to_string(), json!(session.id));
    metadata.insert("runtimeMode".to_string(), json!("team"));
    metadata.insert("collabSessionId".to_string(), json!(session.id));
    metadata.insert("collabMemberId".to_string(), json!(member.id));
    metadata.insert("teamSessionTitle".to_string(), json!(session.title));
    metadata.insert("teamObjective".to_string(), json!(session.objective));
    metadata.insert("memberMentionMode".to_string(), json!(true));
    if let Some(advisor_id) = advisor_id.as_ref() {
        metadata.insert("advisorId".to_string(), json!(advisor_id));
        metadata.insert(
            "memberMentionAdvisorName".to_string(),
            json!(member.display_name),
        );
    }
    metadata.insert("activeSpeaker".to_string(), Value::Object(active_speaker));
    if let Some(member_skill_ref) = member_skill_ref {
        metadata.insert(
            "activeSkills".to_string(),
            json!([member_skill_ref.clone()]),
        );
        metadata.insert("memberSkillRef".to_string(), json!(member_skill_ref));
    }
    Value::Object(metadata)
}

pub(super) fn format_team_member_prompt(
    session: &CollabSessionRecord,
    member: &CollabMemberRecord,
    members: &[CollabMemberRecord],
    tasks: &[CollabTaskRecord],
    messages: &[CollabMailboxMessageRecord],
) -> String {
    let member_lines = members
        .iter()
        .map(|item| {
            format!(
                "- {} ({}, id={}, status={})",
                item.display_name, item.role_id, item.id, item.status
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let task_lines = tasks
        .iter()
        .filter(|task| {
            task.member_id.as_deref() == Some(member.id.as_str()) || task.member_id.is_none()
        })
        .map(|task| {
            format!(
                "- [{}] {} | status={} | objective={}",
                task.id, task.title, task.status, task.objective
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let message_lines = messages
        .iter()
        .map(|message| {
            let from = message
                .from_member_id
                .as_deref()
                .unwrap_or(message.from_kind.as_str());
            format!(
                "- from={} type={} subject={} body={}",
                from,
                message.message_type,
                message.subject.as_deref().unwrap_or(""),
                message.body
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Team runtime wake.\n\nSession: {} ({})\nObjective: {}\n\nYou are: {} ({}, memberId={}).\n\nMembers:\n{}\n\nYour open work items:\n{}\n\nUnread mailbox messages:\n{}\n\nWork instructions:\n- Act only as this team member.\n- If you need to coordinate, use the available team actions/tools to update tasks, submit reports, or send mailbox messages.\n- Produce concrete work or a concrete status update. Keep the final answer concise because the host will save it as this member's progress report.\n- If blocked, say exactly what is blocking you and what should happen next.",
        session.title,
        session.id,
        session.objective,
        member.display_name,
        member.role_id,
        member.id,
        if member_lines.trim().is_empty() {
            "(none)"
        } else {
            &member_lines
        },
        if task_lines.trim().is_empty() {
            "(none)"
        } else {
            &task_lines
        },
        if message_lines.trim().is_empty() {
            "(none)"
        } else {
            &message_lines
        },
    )
}
