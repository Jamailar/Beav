use super::*;

pub(super) fn sync_remote_orders_into_settings(settings: &mut Value, order: &Value) {
    let out_trade_no = payload_string(order, "out_trade_no")
        .or_else(|| payload_string(order, "outTradeNo"))
        .unwrap_or_default();
    if out_trade_no.is_empty() {
        return;
    }
    let mut orders = official_settings_orders(settings);
    let mut updated = false;
    for item in &mut orders {
        let current = payload_string(item, "out_trade_no")
            .or_else(|| payload_string(item, "outTradeNo"))
            .unwrap_or_default();
        if current == out_trade_no {
            *item = order.clone();
            updated = true;
            break;
        }
    }
    if !updated {
        orders.insert(0, order.clone());
    }
    write_settings_json_array(settings, "redbox_auth_orders_json", &orders);
}

pub(super) fn query_remote_order_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    out_trade_no: &str,
    expected_generation: Option<u64>,
) -> Option<Value> {
    let normalized = out_trade_no.trim();
    if normalized.is_empty() {
        return None;
    }
    let encoded = normalized.replace(' ', "%20");
    let remote = run_authenticated_official_request(
        app,
        state,
        settings,
        "GET",
        &format!("/payments/orders/status?out_trade_no={encoded}"),
        None,
        expected_generation,
    )
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/payments/orders/{encoded}"),
            None,
            expected_generation,
        )
    })
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/billing/orders/status?out_trade_no={encoded}"),
            None,
            expected_generation,
        )
    })
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/billing/orders/{encoded}"),
            None,
            expected_generation,
        )
    })
    .or_else(|_| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &format!("/orders/{encoded}"),
            None,
            expected_generation,
        )
    })
    .ok()?;
    Some(official_unwrap_response_payload(&remote))
}
