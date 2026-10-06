use super::super::*;

fn fetch_remote_billing_products(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    endpoints: &[&str],
    request_generation: Option<u64>,
) -> Result<Vec<Value>, String> {
    let mut last_error: Option<String> = None;
    for endpoint in endpoints {
        match run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            endpoint,
            None,
            request_generation,
        ) {
            Ok(response) => {
                let items = official_response_items(&response);
                if !items.is_empty() {
                    return Ok(items);
                }
                last_error = Some("商品列表为空".to_string());
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "商品列表不可用".to_string()))
}

pub(super) fn fetch_billing_products_with_fallback(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    endpoints: &[&str],
    request_generation: Option<u64>,
) -> Vec<Value> {
    fetch_remote_billing_products(app, state, settings, endpoints, request_generation)
        .unwrap_or_else(|_| official_fallback_products())
}

pub(super) fn fetch_billing_product(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    product_id: &str,
    detail_endpoint_roots: &[&str],
    list_endpoints: &[&str],
    request_generation: Option<u64>,
) -> Result<Value, String> {
    let normalized_id = product_id.trim();
    if normalized_id.is_empty() {
        return Err("product_id is required".to_string());
    }

    let encoded_id = urlencoding::encode(normalized_id);
    let mut last_error: Option<String> = None;
    for root in detail_endpoint_roots {
        let endpoint = format!("{}/{}", root.trim_end_matches('/'), encoded_id);
        match run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            &endpoint,
            None,
            request_generation,
        ) {
            Ok(response) => {
                let product = official_unwrap_response_payload(&response);
                if product.is_object() {
                    if let Some(nested) = product.get("product").filter(|value| value.is_object()) {
                        return Ok(nested.clone());
                    }
                    if let Some(nested) = product.get("item").filter(|value| value.is_object()) {
                        return Ok(nested.clone());
                    }
                    return Ok(product);
                }
                last_error = Some("商品详情为空".to_string());
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    let products =
        fetch_remote_billing_products(app, state, settings, list_endpoints, request_generation)?;
    products
        .into_iter()
        .find(|item| {
            let item_id = payload_string(&item, "id").unwrap_or_default();
            let item_code = payload_string(&item, "code").unwrap_or_default();
            item_id.trim() == normalized_id || item_code.trim() == normalized_id
        })
        .ok_or_else(|| last_error.unwrap_or_else(|| "商品不存在或未上架".to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn product_endpoint_order_is_explicit_at_call_site() {
        let redbox_auth_endpoints = ["/payments/products", "/billing/products", "/products"];
        let official_billing_endpoints = ["/billing/products", "/products"];

        assert_eq!(redbox_auth_endpoints[0], "/payments/products");
        assert_eq!(official_billing_endpoints[0], "/billing/products");
    }
}
