use serde_json::{json, Value};

use super::credentials::{
    is_local_base_url, official_logged_in, official_plaintext_key, source_is_official,
};
use super::types::{AiReadiness, AiResolvedRoute};
use crate::now_iso;

pub(crate) fn readiness_from_resolved(
    settings: &Value,
    resolved: Option<AiResolvedRoute>,
) -> AiReadiness {
    let official_logged_in_value = official_logged_in(settings);
    let can_use_official = official_logged_in_value && official_plaintext_key(settings).is_some();
    let Some(route) = resolved else {
        return AiReadiness {
            ready: false,
            mode: "none".to_string(),
            reason: "missing_source".to_string(),
            official_logged_in: official_logged_in_value,
            can_use_official,
            updated_at: now_iso(),
            ..AiReadiness::default()
        };
    };

    let source_official = route
        .source
        .as_object()
        .map(|_| source_is_official(&route.source))
        .unwrap_or(route.is_official);
    let mode = if source_official {
        "official"
    } else if route.is_local || is_local_base_url(&route.base_url) {
        "local"
    } else {
        "custom"
    };
    let mut ready = true;
    let reason = if source_official && !official_logged_in_value {
        ready = false;
        "official_auth_required"
    } else if source_official && !can_use_official {
        ready = false;
        "missing_api_key"
    } else if route.base_url.trim().is_empty() {
        ready = false;
        "missing_base_url"
    } else if route
        .api_key
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
        && mode != "local"
    {
        ready = false;
        "missing_api_key"
    } else if route.model_name.trim().is_empty() {
        ready = false;
        "missing_model"
    } else {
        "ready"
    };

    AiReadiness {
        ready,
        mode: mode.to_string(),
        reason: reason.to_string(),
        source_id: route.source_id,
        source_name: route.source_name,
        base_url: route.base_url,
        model: route.model_name,
        protocol: route.protocol,
        official_logged_in: official_logged_in_value,
        can_use_official,
        can_use_custom: ready && mode != "official",
        updated_at: now_iso(),
    }
}

pub(crate) fn readiness_to_value(readiness: AiReadiness) -> Value {
    json!({
        "ready": readiness.ready,
        "mode": readiness.mode,
        "reason": readiness.reason,
        "sourceId": readiness.source_id,
        "sourceName": readiness.source_name,
        "baseURL": readiness.base_url,
        "model": readiness.model,
        "protocol": readiness.protocol,
        "officialLoggedIn": readiness.official_logged_in,
        "canUseOfficial": readiness.can_use_official,
        "canUseCustom": readiness.can_use_custom,
        "updatedAt": readiness.updated_at,
    })
}
