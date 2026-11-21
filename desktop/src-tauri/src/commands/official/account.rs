use super::*;
use crate::store::settings as settings_store;

pub(super) fn handle_account_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
    request_generation: Option<u64>,
) -> Option<Result<Value, String>> {
    match channel {
        "redbox-auth:redeem-invite-code" => Some((|| -> Result<Value, String> {
            let invite_code = payload_string(payload, "inviteCode")
                .or_else(|| payload_string(payload, "invite_code"))
                .unwrap_or_default();
            if invite_code.trim().is_empty() {
                return Ok(json!({ "success": false, "error": "请输入邀请码" }));
            }
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let result = run_authenticated_official_request(
                app,
                state,
                &mut settings,
                "POST",
                "/users/me/invite-code/redeem",
                Some(json!({ "invite_code": invite_code })),
                request_generation,
            )?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-invite-code-redeem",
                None,
                request_generation,
            )?;
            trigger_official_cached_data_refresh(app.clone());
            Ok(result)
        })()),
        "redbox-auth:points" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let cached_points = cached_official_points(&settings);
            let stale = official_points_need_silent_refresh(&settings);
            let mut error = None;
            let points =
                match fetch_remote_official_points(app, state, &mut settings, request_generation) {
                    Ok(points) => {
                        write_settings_json_value(
                            &mut settings,
                            "redbox_auth_points_json",
                            &points,
                        );
                        points
                    }
                    Err(next_error) => {
                        error = Some(next_error);
                        cached_points
                    }
                };
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-points-query",
                None,
                request_generation,
            )?;
            Ok(json!({
                "success": error.is_none() || points.is_object(),
                "points": points,
                "stale": stale,
                "error": error,
            }))
        })()),
        "redbox-auth:pricing" => Some((|| -> Result<Value, String> {
            with_store(state, |store| {
                let settings = settings_store::settings_snapshot(&store);
                let pricing = official_settings_pricing(&settings);
                Ok(json!({
                    "success": pricing.is_some(),
                    "pricing": pricing,
                    "stale": true,
                }))
            })
        })()),
        "redbox-auth:pricing-refresh" => Some((|| -> Result<Value, String> {
            let pricing = refresh_official_pricing_cache(app, state)?;
            Ok(json!({
                "success": true,
                "pricing": pricing,
                "stale": false,
            }))
        })()),
        "official:account:summary" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let models = official_settings_models(&settings);
            let remote = run_authenticated_official_request(
                app,
                state,
                &mut settings,
                "GET",
                "/account",
                None,
                request_generation,
            )
            .or_else(|_| {
                run_authenticated_official_request(
                    app,
                    state,
                    &mut settings,
                    "GET",
                    "/me",
                    None,
                    request_generation,
                )
            })
            .ok();
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-account-summary",
                None,
                request_generation,
            )?;
            Ok(json!({
                "success": true,
                "summary": remote.unwrap_or_else(|| official_account_summary_local(&settings, &models))
            }))
        })()),
        _ => None,
    }
}
