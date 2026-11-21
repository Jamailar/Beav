mod parser;
mod types;

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

use types::DeepLinkEventPayload;

const DEEP_LINK_EVENT: &str = "app:deep-link";
const MAX_PENDING_EVENTS: usize = 16;

static PENDING_EVENTS: OnceLock<Mutex<VecDeque<DeepLinkEventPayload>>> = OnceLock::new();

fn pending_events() -> &'static Mutex<VecDeque<DeepLinkEventPayload>> {
    PENDING_EVENTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

pub(crate) fn install(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            accept_url(&app_handle, "runtime", url.as_str());
        }
    });

    if let Some(urls) = app.deep_link().get_current()? {
        let app_handle = app.handle().clone();
        for url in urls {
            accept_url(&app_handle, "startup", url.as_str());
        }
    }

    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link().register_all()?;

    Ok(())
}

pub(crate) fn consume_pending_events() -> Value {
    let items = pending_events()
        .lock()
        .map(|mut events| events.drain(..).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "success": true,
        "items": items,
    })
}

fn accept_url(app: &AppHandle, source: &str, raw_url: &str) {
    let payload = event_payload(source, raw_url);
    push_pending(payload.clone());
    let _ = app.emit(DEEP_LINK_EVENT, payload);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        let _ = window.unminimize();
        let _ = window.show();
    }
}

fn event_payload(source: &str, raw_url: &str) -> DeepLinkEventPayload {
    match parser::parse_deep_link(raw_url) {
        Ok(intent) => DeepLinkEventPayload {
            success: true,
            source: source.to_string(),
            raw_url: raw_url.to_string(),
            received_at: crate::now_iso(),
            intent: Some(intent),
            error: None,
        },
        Err(error) => DeepLinkEventPayload {
            success: false,
            source: source.to_string(),
            raw_url: raw_url.to_string(),
            received_at: crate::now_iso(),
            intent: None,
            error: Some(error.payload()),
        },
    }
}

fn push_pending(payload: DeepLinkEventPayload) {
    if let Ok(mut events) = pending_events().lock() {
        events.push_back(payload);
        while events.len() > MAX_PENDING_EVENTS {
            events.pop_front();
        }
    }
}
