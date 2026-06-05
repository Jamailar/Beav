use super::*;
use crate::store::settings as settings_store;

fn normalize_official_pricing_value(value: &Value) -> Option<Value> {
    let payload = official_unwrap_response_payload(value);
    let groups = payload.get("groups")?.as_array()?;
    if groups.is_empty() {
        return None;
    }
    Some(payload)
}

pub(crate) fn refresh_official_pricing_cache(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let settings_snapshot =
        with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
    let mut settings = settings_snapshot.clone();
    let response = run_official_public_json_request(&settings, "GET", "/models/pricing", None)?;
    let pricing = normalize_official_pricing_value(&response)
        .ok_or_else(|| "官方价格表接口返回了无法识别的数据结构".to_string())?;
    write_settings_json_value(&mut settings, "redbox_official_pricing_json", &pricing);
    apply_official_settings_update(
        app,
        state,
        &settings,
        "official-pricing-startup-refresh",
        Some(json!({ "pricing": pricing.clone() })),
        None,
    )?;
    Ok(pricing)
}
