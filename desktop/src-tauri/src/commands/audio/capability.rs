use cpal::traits::{DeviceTrait, HostTrait};
use serde_json::{json, Value};

fn classify_audio_error(error: &str) -> &'static str {
    let normalized = error.trim().to_lowercase();
    if normalized.is_empty() {
        return "unknown";
    }
    if normalized.contains("permission")
        || normalized.contains("not permitted")
        || normalized.contains("unauthorized")
        || normalized.contains("access denied")
        || normalized.contains("operation not permitted")
    {
        return "permission_denied";
    }
    if normalized.contains("device")
        || normalized.contains("input")
        || normalized.contains("microphone")
        || normalized.contains("stream")
    {
        return "device_unavailable";
    }
    "host_error"
}

pub(crate) fn audio_error_reason(error: &str) -> &'static str {
    classify_audio_error(error)
}

pub(crate) fn capture_capability_value(recording_active: bool) -> Value {
    let host = cpal::default_host();
    let platform = std::env::consts::OS;
    let Some(device) = host.default_input_device() else {
        return json!({
            "success": true,
            "available": false,
            "activeRecording": recording_active,
            "platform": platform,
            "reason": "no_input_device",
            "message": "未检测到可用麦克风设备",
        });
    };

    let device_name = device.name().unwrap_or_else(|_| "默认输入设备".to_string());

    match device.default_input_config() {
        Ok(config) => json!({
            "success": true,
            "available": true,
            "activeRecording": recording_active,
            "platform": platform,
            "reason": Value::Null,
            "deviceName": device_name,
            "sampleRate": config.sample_rate().0,
            "channels": config.channels(),
            "sampleFormat": format!("{:?}", config.sample_format()),
        }),
        Err(error) => {
            let message = error.to_string();
            json!({
                "success": true,
                "available": false,
                "activeRecording": recording_active,
                "platform": platform,
                "reason": classify_audio_error(&message),
                "deviceName": device_name,
                "message": message,
            })
        }
    }
}
