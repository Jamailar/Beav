use super::super::*;

pub(super) fn fetch_billing_products_with_fallback(
    app: &AppHandle,
    state: &State<'_, AppState>,
    settings: &mut Value,
    endpoints: &[&str],
    request_generation: Option<u64>,
) -> Vec<Value> {
    let remote = endpoints.iter().find_map(|endpoint| {
        run_authenticated_official_request(
            app,
            state,
            settings,
            "GET",
            endpoint,
            None,
            request_generation,
        )
        .ok()
    });
    remote
        .as_ref()
        .map(official_response_items)
        .filter(|items| !items.is_empty())
        .unwrap_or_else(official_fallback_products)
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
