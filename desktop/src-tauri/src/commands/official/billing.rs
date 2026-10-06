use super::*;
use crate::store::settings as settings_store;

#[path = "billing/orders.rs"]
mod orders;
#[path = "billing/products.rs"]
mod products;

use orders::{query_remote_order_status, sync_remote_orders_into_settings};
use products::{fetch_billing_product, fetch_billing_products_with_fallback};

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
            let remote_order = run_authenticated_official_request_skip_preflight_refresh(
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
            )
            .map(|response| official_unwrap_response_payload(&response));
            let order = match remote_order {
                Ok(order) => order,
                Err(error) if product_id.is_some() => {
                    return Ok(json!({ "success": false, "error": error }));
                }
                Err(_) => {
                    let out_trade_no = make_id("order");
                    let payment_form =
                        create_official_payment_form(&out_trade_no, amount, &subject);
                    json!({
                        "id": out_trade_no,
                        "out_trade_no": out_trade_no,
                        "outTradeNo": out_trade_no,
                        "status": "PENDING",
                        "trade_status": "PENDING",
                        "amount": amount,
                        "subject": subject,
                        "payment_form": payment_form,
                        "created_at": now_iso(),
                    })
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
            crate::analytics::observe_billing_order_created(
                state,
                &order,
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
            let order = run_authenticated_official_request(
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
                        run_authenticated_official_request(
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
                    .map(|response| official_unwrap_response_payload(&response))
                    .unwrap_or_else(|_| {
                        json!({
                            "id": out_trade_no,
                            "out_trade_no": out_trade_no,
                            "outTradeNo": out_trade_no,
                            "status": "PENDING",
                            "trade_status": "PENDING",
                            "amount": amount,
                            "code_url": format!("weixin://wxpay/bizpayurl?pr={}", out_trade_no),
                            "created_at": now_iso(),
                        })
                    });
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
            crate::analytics::observe_billing_order_created(
                state,
                &order,
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
            match open_payment_form(&payment_form) {
                Ok(opened) => Ok(json!({ "success": true, "opened": opened })),
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
            let order = run_authenticated_official_request(
                app,
                state,
                &mut settings,
                "POST",
                "/billing/orders",
                Some(body.clone()),
                request_generation,
            )
            .or_else(|_| {
                run_authenticated_official_request(
                    app,
                    state,
                    &mut settings,
                    "POST",
                    "/orders",
                    Some(body),
                    request_generation,
                )
            })
            .unwrap_or_else(|_| {
                json!({
                    "id": make_id("official-order"),
                    "status": "PENDING",
                    "trade_status": "PENDING",
                    "payment_url": official_base_url_from_settings(&settings),
                    "amount": amount.unwrap_or(0.0),
                    "product_id": product_id,
                    "created_at": now_iso(),
                })
            });
            apply_official_settings_update(
                app,
                state,
                &settings,
                "official-billing-create-order",
                None,
                request_generation,
            )?;
            crate::analytics::observe_billing_order_created(
                state,
                &order,
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
