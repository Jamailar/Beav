use super::*;
use crate::store::settings as settings_store;

#[path = "billing/orders.rs"]
mod orders;
#[path = "billing/products.rs"]
mod products;

use orders::{query_remote_order_status, sync_remote_orders_into_settings};
use products::{fetch_billing_product, fetch_billing_products_with_fallback};

fn analytics_order_snapshot(order: &Value, payload: &Value) -> Value {
    let mut next = order.clone();
    if let Some(acquisition_source) = payload_string(payload, "acquisitionSource")
        .or_else(|| payload_string(payload, "acquisition_source"))
        .filter(|value| !value.trim().is_empty())
    {
        if let Some(object) = next.as_object_mut() {
            object.insert("acquisitionSource".to_string(), json!(acquisition_source));
        }
    }
    next
}

fn payment_order_has_trade_no(order: &Value) -> bool {
    payload_string(order, "out_trade_no")
        .or_else(|| payload_string(order, "outTradeNo"))
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn payment_order_has_target(order: &Value) -> bool {
    [
        "payment_url",
        "paymentUrl",
        "payment_form",
        "paymentForm",
        "url",
        "code_url",
        "qr_code",
        "qrCode",
    ]
    .into_iter()
    .any(|key| {
        payload_string(order, key)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

fn create_order_error_payload(error: impl Into<String>) -> Value {
    let error = error.into();
    let message = if auth::classify_auth_error(&error) == auth::AuthErrorKind::ReauthRequired {
        "登录状态已失效，请重新登录后再充值".to_string()
    } else {
        format!("创建支付订单失败：{error}")
    };
    json!({ "success": false, "error": message })
}

fn unwrap_payment_order_response(response: crate::HttpJsonResponse) -> Result<Value, String> {
    if !(200..300).contains(&response.status) {
        return Err(response_error_message(&response.body));
    }
    let order = official_unwrap_response_payload(&response.body);
    if !payment_order_has_trade_no(&order) || !payment_order_has_target(&order) {
        return Err("订单返回缺少支付信息".to_string());
    }
    Ok(order)
}

pub(super) fn handle_billing_channel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
    request_generation: Option<u64>,
) -> Option<Result<Value, String>> {
    match channel {
        "redbox-auth:products" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let products = fetch_billing_products_with_fallback(
                app,
                state,
                &mut settings,
                &["/payments/products", "/billing/products", "/products"],
                request_generation,
            );
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-products",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "products": products }))
        })()),
        "redbox-auth:product" => Some((|| -> Result<Value, String> {
            let product_id = payload_string(payload, "productId")
                .or_else(|| payload_string(payload, "product_id"))
                .unwrap_or_default();
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let product = fetch_billing_product(
                app,
                state,
                &mut settings,
                &product_id,
                &["/payments/products", "/billing/products", "/products"],
                &["/payments/products", "/billing/products", "/products"],
                request_generation,
            )?;
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-product",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "product": product }))
        })()),
        "redbox-auth:call-records" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let cached_records = normalize_official_call_record_items(
                &official_settings_call_records_list(&settings),
            );
            let remote =
                fetch_remote_official_call_records(app, state, &mut settings, request_generation);
            let mut error = None;
            let records = match remote {
                Ok(records) => {
                    write_settings_json_array(
                        &mut settings,
                        "redbox_auth_call_records_json",
                        &records,
                    );
                    records
                }
                Err(next_error) => {
                    error = Some(next_error);
                    cached_records
                }
            };
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-call-records",
                None,
                request_generation,
            )?;
            if let Some(message) = error {
                let has_records = !records.is_empty();
                return Ok(json!({
                    "success": has_records,
                    "records": records,
                    "error": message,
                }));
            }
            Ok(json!({ "success": true, "records": records }))
        })()),
        "redbox-auth:create-page-pay-order" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let amount = payload_f64(payload, "amount").unwrap_or(9.9);
            let subject = payload_string(payload, "subject")
                .unwrap_or_else(|| format!("积分充值 ¥{amount:.2}"));
            let product_id = payload_string(payload, "productId")
                .or_else(|| payload_string(payload, "product_id"))
                .filter(|value| !value.trim().is_empty());
            let points_to_deduct = payload_i64(payload, "pointsToDeduct")
                .or_else(|| payload_i64(payload, "points_to_deduct"))
                .unwrap_or(0);
            let remote_order = run_authenticated_official_request_response(
                app,
                state,
                &mut settings,
                "POST",
                "/payments/orders/page-pay",
                Some(json!({
                    "product_id": product_id.clone(),
                    "productId": product_id.clone(),
                    "amount": amount,
                    "amount_yuan": amount,
                    "subject": subject,
                    "title": subject,
                    "points_to_deduct": points_to_deduct,
                    "pointsToDeduct": points_to_deduct,
                })),
                request_generation,
            );
            let order = match remote_order.and_then(unwrap_payment_order_response) {
                Ok(order) => order,
                Err(error) => {
                    return Ok(create_order_error_payload(error));
                }
            };
            let mut orders = official_settings_orders(&settings);
            orders.insert(0, order.clone());
            write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-order-create",
                None,
                request_generation,
            )?;
            let analytics_order = analytics_order_snapshot(&order, payload);
            crate::analytics::observe_billing_order_created(
                state,
                &analytics_order,
                "official-order-create",
                "page_pay",
            );
            Ok(json!({ "success": true, "order": order }))
        })()),
        "redbox-auth:create-wechat-native-order" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let amount = payload_f64(payload, "amount").unwrap_or(9.9);
            let out_trade_no = make_id("wxpay");
            let order = run_authenticated_official_request_response(
                app,
                state,
                &mut settings,
                "POST",
                "/payments/orders/wechat-native",
                Some(json!({
                    "product_id": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                    "productId": payload_string(payload, "productId").filter(|value| !value.trim().is_empty()),
                    "amount": amount,
                    "amount_yuan": amount,
                    "subject": payload_string(payload, "subject").unwrap_or_else(|| format!("积分充值 ¥{amount:.2}")),
                })),
                request_generation,
            )
            .or_else(|_| {
                run_authenticated_official_request_response(
                    app,
                    state,
                    &mut settings,
                    "POST",
                    "/wechat/pay/native",
                    Some(json!({
                        "amount": amount,
                        "out_trade_no": out_trade_no,
                    })),
                    request_generation,
                )
            })
            .and_then(unwrap_payment_order_response);
            let order = match order {
                Ok(order) => order,
                Err(error) => {
                    return Ok(create_order_error_payload(error));
                }
            };
            let mut orders = official_settings_orders(&settings);
            orders.insert(0, order.clone());
            write_settings_json_array(&mut settings, "redbox_auth_orders_json", &orders);
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-wechat-order-create",
                None,
                request_generation,
            )?;
            let analytics_order = analytics_order_snapshot(&order, payload);
            crate::analytics::observe_billing_order_created(
                state,
                &analytics_order,
                "official-wechat-order-create",
                "wechat_native",
            );
            Ok(json!({ "success": true, "order": order }))
        })()),
        "redbox-auth:order-status" => Some((|| -> Result<Value, String> {
            let out_trade_no = payload_string(payload, "outTradeNo").unwrap_or_default();
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let order = query_remote_order_status(
                app,
                state,
                &mut settings,
                &out_trade_no,
                request_generation,
            )
            .unwrap_or_else(|| {
                official_settings_orders(&settings)
                    .into_iter()
                    .find(|item| {
                        payload_string(item, "out_trade_no")
                            .or_else(|| payload_string(item, "outTradeNo"))
                            .map(|value| value == out_trade_no)
                            .unwrap_or(false)
                    })
                    .unwrap_or_else(|| {
                        json!({
                            "out_trade_no": out_trade_no,
                            "outTradeNo": out_trade_no,
                            "status": "PENDING",
                            "trade_status": "PENDING",
                        })
                    })
            });
            sync_remote_orders_into_settings(&mut settings, &order);
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-order-status",
                None,
                request_generation,
            )?;
            crate::analytics::observe_billing_order_status(state, &order, "official-order-status");
            Ok(json!({ "success": true, "order": order }))
        })()),
        "redbox-auth:open-payment-form" => Some((|| -> Result<Value, String> {
            let payment_form = payload_string(payload, "paymentForm").unwrap_or_default();
            match open_payment_form(app, &payment_form) {
                Ok(opened) => {
                    crate::analytics::observe_billing_payment_opened(
                        state,
                        "official-payment-open",
                        &opened,
                    );
                    Ok(json!({ "success": true, "opened": opened }))
                }
                Err(error) => Ok(json!({ "success": false, "error": error })),
            }
        })()),
        "official:billing:products" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let products = fetch_billing_products_with_fallback(
                app,
                state,
                &mut settings,
                &["/billing/products", "/products"],
                request_generation,
            );
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-billing-products",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "products": products }))
        })()),
        "official:billing:list-orders" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let remote = run_authenticated_official_request(
                app,
                state,
                &mut settings,
                "GET",
                "/billing/orders",
                None,
                request_generation,
            )
            .or_else(|_| {
                run_authenticated_official_request(
                    app,
                    state,
                    &mut settings,
                    "GET",
                    "/orders",
                    None,
                    request_generation,
                )
            })
            .ok();
            let orders = remote
                .as_ref()
                .map(official_response_items)
                .unwrap_or_default();
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-billing-list-orders",
                None,
                request_generation,
            )?;
            Ok(json!({ "success": true, "orders": orders }))
        })()),
        "official:billing:create-order" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let product_id = payload_string(payload, "productId").unwrap_or_default();
            let amount = payload_f64(payload, "amount");
            let body = json!({
                "product_id": product_id,
                "productId": payload_string(payload, "productId"),
                "amount": amount,
                "currency": payload_string(payload, "currency").unwrap_or_else(|| "CNY".to_string()),
            });
            let order = run_authenticated_official_request_response(
                app,
                state,
                &mut settings,
                "POST",
                "/billing/orders",
                Some(body.clone()),
                request_generation,
            )
            .or_else(|_| {
                run_authenticated_official_request_response(
                    app,
                    state,
                    &mut settings,
                    "POST",
                    "/orders",
                    Some(body),
                    request_generation,
                )
            })
            .and_then(unwrap_payment_order_response);
            let order = match order {
                Ok(order) => order,
                Err(error) => {
                    return Ok(create_order_error_payload(error));
                }
            };
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-billing-create-order",
                None,
                request_generation,
            )?;
            let analytics_order = analytics_order_snapshot(&order, payload);
            crate::analytics::observe_billing_order_created(
                state,
                &analytics_order,
                "official-billing-create-order",
                "official_billing",
            );
            Ok(json!({ "success": true, "order": order }))
        })()),
        "official:billing:list-calls" => Some((|| -> Result<Value, String> {
            let settings_snapshot =
                with_store(state, |store| Ok(settings_store::settings_snapshot(&store)))?;
            let mut settings = settings_snapshot.clone();
            let result = match fetch_remote_official_call_records(
                app,
                state,
                &mut settings,
                request_generation,
            ) {
                Ok(records) => json!({ "success": true, "records": records }),
                Err(error) => json!({ "success": false, "records": [], "error": error }),
            };
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-billing-list-calls",
                None,
                request_generation,
            )?;
            Ok(result)
        })()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwrap_payment_order_response_accepts_real_payment_target() {
        let order = unwrap_payment_order_response(crate::HttpJsonResponse {
            status: 201,
            body: json!({
                "out_trade_no": "ALI20260702100127D2CE3D22",
                "payment_form": "<form id=\"alipaysubmit\"></form>"
            }),
        })
        .expect("valid page-pay order should pass");

        assert_eq!(
            payload_string(&order, "out_trade_no").as_deref(),
            Some("ALI20260702100127D2CE3D22")
        );
    }

    #[test]
    fn unwrap_payment_order_response_rejects_missing_payment_target() {
        let error = unwrap_payment_order_response(crate::HttpJsonResponse {
            status: 201,
            body: json!({
                "out_trade_no": "order-1782984364553",
                "status": "PENDING"
            }),
        })
        .expect_err("orders without a payment target must not be treated as payable");

        assert_eq!(error, "订单返回缺少支付信息");
    }
}
