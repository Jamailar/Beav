use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

use crate::persistence::with_store;
use crate::store::settings as settings_store;
use crate::{auth, official_settings_session, AppState};

pub(crate) const ENTITLEMENT_SPACES_CREATE: &str = "spaces.create";
pub(crate) const ENTITLEMENT_SPACES_CREATE_UNLIMITED: &str = "spaces.create.unlimited";
pub(crate) const ENTITLEMENT_DEVICES_LOGIN_UNLIMITED: &str = "devices.login.unlimited";
pub(crate) const ENTITLEMENT_FEATURES_MEMBER_ONLY: &str = "features.member_only";
pub(crate) const ENTITLEMENT_SUPPORT_PRIORITY: &str = "support.priority";

const PREMIUM_PLANS: &[&str] = &["premium", "founder", "founder_sponsor", "founder-sponsor"];

#[derive(Debug, Clone, Default)]
pub(crate) struct MembershipState {
    pub active: bool,
    pub entitlements: BTreeMap<String, Value>,
}

fn parse_time_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                chrono::DateTime::parse_from_rfc3339(trimmed)
                    .map(|datetime| datetime.timestamp_millis())
                    .ok()
                    .or_else(|| trimmed.parse::<i64>().ok())
            }
        }
        _ => None,
    }
}

fn value_contains_founder(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let normalized = value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
        .trim()
        .to_lowercase();
    [
        "founder",
        "founding",
        "founder_sponsor",
        "founder-sponsor",
        "创始",
        "赞助",
    ]
    .iter()
    .any(|token| normalized.contains(token))
}

fn record_is_active_founder(record: Option<&Value>) -> bool {
    let Some(record) = record.and_then(Value::as_object) else {
        return false;
    };
    let status = record
        .get("status")
        .or_else(|| record.get("state"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let explicitly_inactive = record.get("active").and_then(Value::as_bool) == Some(false)
        || record.get("enabled").and_then(Value::as_bool) == Some(false)
        || matches!(
            status.as_str(),
            "inactive" | "expired" | "cancelled" | "canceled"
        );
    if explicitly_inactive {
        return false;
    }
    [
        "tier",
        "type",
        "badge",
        "product_id",
        "productId",
        "plan",
        "scope",
        "name",
        "label",
    ]
    .iter()
    .any(|key| value_contains_founder(record.get(*key)))
}

fn merge_entitlement(
    entitlements: &mut BTreeMap<String, Value>,
    key: Option<&Value>,
    value: Value,
) {
    let Some(key) = key else {
        return;
    };
    let normalized = key
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| key.to_string())
        .trim()
        .to_string();
    if normalized.is_empty() {
        return;
    }
    entitlements.insert(normalized, value);
}

fn collect_entitlements(value: Option<&Value>, entitlements: &mut BTreeMap<String, Value>) {
    let Some(value) = value else {
        return;
    };
    if let Some(items) = value.as_array() {
        for item in items {
            if item.is_string() {
                merge_entitlement(entitlements, Some(item), Value::Bool(true));
                continue;
            }
            let Some(record) = item.as_object() else {
                continue;
            };
            let status = record
                .get("status")
                .or_else(|| record.get("state"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            if record.get("active").and_then(Value::as_bool) == Some(false)
                || matches!(
                    status.as_str(),
                    "inactive" | "expired" | "cancelled" | "canceled"
                )
            {
                continue;
            }
            let key = record
                .get("key")
                .or_else(|| record.get("entitlement"))
                .or_else(|| record.get("scope"))
                .or_else(|| record.get("name"))
                .or_else(|| record.get("code"));
            let value = record
                .get("value")
                .or_else(|| record.get("enabled"))
                .cloned()
                .unwrap_or(Value::Bool(true));
            merge_entitlement(entitlements, key, value);
        }
        return;
    }
    if let Some(record) = value.as_object() {
        for (key, value) in record {
            entitlements.insert(key.to_string(), value.clone());
        }
    }
}

fn user_has_active_premium_membership(user: Option<&Value>) -> bool {
    let Some(user) = user.and_then(Value::as_object) else {
        return false;
    };
    let plan = user
        .get("membership_type")
        .or_else(|| user.get("membershipType"))
        .or_else(|| user.get("memberType"))
        .and_then(Value::as_str)
        .unwrap_or("free")
        .trim()
        .to_lowercase();
    let expires_at_ms = user
        .get("membership_expires_at")
        .or_else(|| user.get("membershipExpiresAt"))
        .and_then(parse_time_ms);
    PREMIUM_PLANS.contains(&plan.as_str())
        && expires_at_ms.is_none_or(|timestamp| timestamp > chrono::Utc::now().timestamp_millis())
}

fn state_from_session(session: Option<&Value>) -> MembershipState {
    let Some(session_object) = session.and_then(Value::as_object) else {
        return MembershipState::default();
    };
    let user = session_object.get("user");
    let membership_active = user_has_active_premium_membership(user);
    let mut entitlements = BTreeMap::new();

    collect_entitlements(session_object.get("entitlements"), &mut entitlements);
    collect_entitlements(
        user.and_then(|value| value.get("entitlements")),
        &mut entitlements,
    );
    collect_entitlements(
        session_object
            .get("membership")
            .and_then(|value| value.get("entitlements")),
        &mut entitlements,
    );
    collect_entitlements(
        user.and_then(|value| value.get("membership"))
            .and_then(|value| value.get("entitlements")),
        &mut entitlements,
    );

    let founder_candidates = [
        session_object.get("membership"),
        session_object.get("subscription"),
        session_object.get("founderMembership"),
        session_object.get("founder_sponsor"),
        user.and_then(|value| value.get("membership")),
        user.and_then(|value| value.get("subscription")),
        user.and_then(|value| value.get("founderMembership")),
        user.and_then(|value| value.get("founder_sponsor")),
    ];
    let founder_active = founder_candidates.into_iter().any(record_is_active_founder)
        || [
            session_object.get("memberships"),
            user.and_then(|value| value.get("memberships")),
        ]
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .any(|items| {
            items
                .iter()
                .any(|item| record_is_active_founder(Some(item)))
        });

    let active = membership_active || founder_active;
    if active {
        for key in [
            ENTITLEMENT_SPACES_CREATE,
            ENTITLEMENT_SPACES_CREATE_UNLIMITED,
            ENTITLEMENT_DEVICES_LOGIN_UNLIMITED,
            ENTITLEMENT_FEATURES_MEMBER_ONLY,
            ENTITLEMENT_SUPPORT_PRIORITY,
        ] {
            entitlements
                .entry(key.to_string())
                .or_insert(Value::Bool(true));
        }
    }

    MembershipState {
        active,
        entitlements,
    }
}

fn merge_membership_state(primary: MembershipState, fallback: MembershipState) -> MembershipState {
    if primary.active || !primary.entitlements.is_empty() {
        return primary;
    }
    fallback
}

pub(crate) fn membership_state(state: &State<'_, AppState>) -> Result<MembershipState, String> {
    let snapshot = auth::auth_state_snapshot(state).unwrap_or_default();
    let runtime_state = state_from_session(snapshot.session.as_ref());
    let settings_session = with_store(state, |store| {
        let settings = settings_store::settings_snapshot(&store);
        Ok(official_settings_session(&settings))
    })?;
    let settings_state = state_from_session(settings_session.as_ref());
    Ok(merge_membership_state(runtime_state, settings_state))
}

fn entitlement_value_is_enabled(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().map(|number| number > 0.0).unwrap_or(false),
        Some(Value::String(value)) => !matches!(
            value.trim().to_lowercase().as_str(),
            "" | "0" | "false" | "no" | "disabled"
        ),
        _ => false,
    }
}

pub(crate) fn can_use_entitlement(membership: &MembershipState, entitlement: &str) -> bool {
    if entitlement_value_is_enabled(membership.entitlements.get(entitlement)) {
        return true;
    }
    if entitlement == ENTITLEMENT_SPACES_CREATE {
        return entitlement_value_is_enabled(
            membership
                .entitlements
                .get(ENTITLEMENT_SPACES_CREATE_UNLIMITED),
        );
    }
    false
}

pub(crate) fn ensure_entitlement(
    state: &State<'_, AppState>,
    entitlement: &str,
    error_message: &str,
) -> Result<(), String> {
    let membership = membership_state(state)?;
    if can_use_entitlement(&membership, entitlement) {
        return Ok(());
    }
    Err(error_message.to_string())
}
