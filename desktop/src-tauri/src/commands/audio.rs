use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use serde_json::{Value, json};
use std::io::Cursor;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::{AppState, now_ms};

const PREFERRED_INPUT_SAMPLE_RATE: u32 = 48_000;
const MIN_REASONABLE_INPUT_SAMPLE_RATE: u32 = 8_000;
const MAX_REASONABLE_INPUT_SAMPLE_RATE: u32 = 96_000;
const MAX_RECORDING_CAPTURE_DRIFT_MS: u64 = 3_000;

struct ActiveAudioRecording {
    stop_tx: mpsc::Sender<()>,
    join: Option<JoinHandle<()>>,
    samples: Arc<Mutex<Vec<i16>>>,
    last_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
    channels: u16,
    started_at: Instant,
    device_name: String,
}

struct RecordingStartInfo {
    sample_rate: u32,
    channels: u16,
    device_name: String,
}

static ACTIVE_AUDIO_RECORDING: OnceLock<Mutex<Option<ActiveAudioRecording>>> = OnceLock::new();

fn active_audio_recording() -> &'static Mutex<Option<ActiveAudioRecording>> {
    ACTIVE_AUDIO_RECORDING.get_or_init(|| Mutex::new(None))
}

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

fn capture_capability_value() -> Value {
    let host = cpal::default_host();
    let recording_active = active_audio_recording()
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
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

fn push_f32_samples(buffer: &Arc<Mutex<Vec<i16>>>, data: &[f32]) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend(data.iter().map(|sample| {
            sample
                .clamp(-1.0, 1.0)
                .mul_add(i16::MAX as f32, 0.0)
                .round() as i16
        }));
    }
}

fn push_i16_samples(buffer: &Arc<Mutex<Vec<i16>>>, data: &[i16]) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend_from_slice(data);
    }
}

fn push_u16_samples(buffer: &Arc<Mutex<Vec<i16>>>, data: &[u16]) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend(data.iter().map(|sample| (*sample as i32 - 32_768) as i16));
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    samples: Arc<Mutex<Vec<i16>>>,
    last_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    let err_fn = move |error: cpal::StreamError| {
        if let Ok(mut guard) = last_error.lock() {
            *guard = Some(error.to_string());
        }
    };

    match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                {
                    let samples = Arc::clone(&samples);
                    move |data: &[f32], _| push_f32_samples(&samples, data)
                },
                err_fn,
                None,
            )
            .map_err(|error| error.to_string()),
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                {
                    let samples = Arc::clone(&samples);
                    move |data: &[i16], _| push_i16_samples(&samples, data)
                },
                err_fn,
                None,
            )
            .map_err(|error| error.to_string()),
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                {
                    let samples = Arc::clone(&samples);
                    move |data: &[u16], _| push_u16_samples(&samples, data)
                },
                err_fn,
                None,
            )
            .map_err(|error| error.to_string()),
        other => Err(format!("当前宿主录音暂不支持采样格式 {other:?}")),
    }
}

fn choose_recording_input_config(
    device: &cpal::Device,
) -> Result<(StreamConfig, SampleFormat), String> {
    let default_config = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let default_rate = default_config.sample_rate().0;
    let default_channels = default_config.channels();
    if (MIN_REASONABLE_INPUT_SAMPLE_RATE..=MAX_REASONABLE_INPUT_SAMPLE_RATE).contains(&default_rate)
        && (1..=2).contains(&default_channels)
    {
        return Ok((default_config.config(), default_config.sample_format()));
    }

    let mut fallback = None;
    let supported_configs = device
        .supported_input_configs()
        .map_err(|error| error.to_string())?;
    for config_range in supported_configs {
        if !matches!(
            config_range.sample_format(),
            SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
        ) {
            continue;
        }
        let min_rate = config_range.min_sample_rate().0;
        let max_rate = config_range.max_sample_rate().0;
        if max_rate < MIN_REASONABLE_INPUT_SAMPLE_RATE
            || min_rate > MAX_REASONABLE_INPUT_SAMPLE_RATE
        {
            continue;
        }
        let target_rate =
            if min_rate <= PREFERRED_INPUT_SAMPLE_RATE && max_rate >= PREFERRED_INPUT_SAMPLE_RATE {
                PREFERRED_INPUT_SAMPLE_RATE
            } else {
                max_rate.min(MAX_REASONABLE_INPUT_SAMPLE_RATE).max(min_rate)
            };
        let supported_config = config_range.with_sample_rate(SampleRate(target_rate));
        let config = supported_config.config();
        let sample_format = supported_config.sample_format();
        if (1..=2).contains(&config.channels) {
            return Ok((config, sample_format));
        }
        fallback.get_or_insert((config, sample_format));
    }

    Ok(fallback.unwrap_or_else(|| (default_config.config(), default_config.sample_format())))
}

fn encode_wav_bytes(samples: &[i16], sample_rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer =
            hound::WavWriter::new(&mut cursor, spec).map_err(|error| error.to_string())?;
        for sample in samples {
            writer
                .write_sample(*sample)
                .map_err(|error| error.to_string())?;
        }
        writer.finalize().map_err(|error| error.to_string())?;
    }
    Ok(cursor.into_inner())
}

fn spawn_recording_thread(
    samples: Arc<Mutex<Vec<i16>>>,
    last_error: Arc<Mutex<Option<String>>>,
) -> (
    mpsc::Sender<()>,
    mpsc::Receiver<Result<RecordingStartInfo, String>>,
    JoinHandle<()>,
) {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<RecordingStartInfo, String>>();
    let join = std::thread::spawn(move || {
        let start_result = (|| -> Result<(cpal::Stream, RecordingStartInfo), String> {
            let host = cpal::default_host();
            let device = host
                .default_input_device()
                .ok_or_else(|| "未检测到可用麦克风设备".to_string())?;
            let device_name = device.name().unwrap_or_else(|_| "默认输入设备".to_string());
            let (config, sample_format) = choose_recording_input_config(&device)?;
            let sample_rate = config.sample_rate.0;
            let channels = config.channels;
            let stream = build_input_stream(
                &device,
                &config,
                sample_format,
                Arc::clone(&samples),
                Arc::clone(&last_error),
            )?;
            stream.play().map_err(|error| error.to_string())?;
            Ok((
                stream,
                RecordingStartInfo {
                    sample_rate,
                    channels,
                    device_name,
                },
            ))
        })();

        match start_result {
            Ok((stream, info)) => {
                let _ = ready_tx.send(Ok(info));
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        }
    });
    (stop_tx, ready_rx, join)
}

fn start_recording() -> Result<Value, String> {
    let mut guard = active_audio_recording()
        .lock()
        .map_err(|_| "音频录制状态锁异常".to_string())?;
    if guard.is_some() {
        return Ok(json!({
            "success": false,
            "reason": "already_recording",
            "error": "已有录音任务正在进行",
        }));
    }

    let samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let last_error = Arc::new(Mutex::new(None));
    let (stop_tx, ready_rx, join) =
        spawn_recording_thread(Arc::clone(&samples), Arc::clone(&last_error));
    let info = match ready_rx.recv() {
        Ok(Ok(info)) => info,
        Ok(Err(error)) => {
            let _ = join.join();
            return Ok(json!({
                "success": false,
                "reason": classify_audio_error(&error),
                "error": error,
            }));
        }
        Err(error) => {
            let _ = join.join();
            return Err(error.to_string());
        }
    };

    *guard = Some(ActiveAudioRecording {
        stop_tx,
        join: Some(join),
        samples,
        last_error,
        sample_rate: info.sample_rate,
        channels: info.channels,
        started_at: Instant::now(),
        device_name: info.device_name.clone(),
    });

    Ok(json!({
        "success": true,
        "strategy": "native",
        "deviceName": info.device_name,
        "sampleRate": info.sample_rate,
        "channels": info.channels,
        "startedAt": now_ms(),
    }))
}

fn stop_recording(discard: bool) -> Result<Value, String> {
    let mut guard = active_audio_recording()
        .lock()
        .map_err(|_| "音频录制状态锁异常".to_string())?;
    let Some(mut active) = guard.take() else {
        return Ok(json!({
            "success": false,
            "reason": "not_recording",
            "error": "当前没有进行中的录音",
        }));
    };

    let _ = active.stop_tx.send(());
    if let Some(join) = active.join.take() {
        let _ = join.join();
    }

    let samples = active
        .samples
        .lock()
        .map_err(|_| "录音样本锁异常".to_string())?
        .clone();
    let runtime_error = active
        .last_error
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let duration_ms = active.started_at.elapsed().as_millis() as u64;

    if discard {
        return Ok(json!({
            "success": true,
            "discarded": true,
            "durationMs": duration_ms,
        }));
    }

    if samples.is_empty() {
        return Ok(json!({
            "success": false,
            "reason": runtime_error
                .as_deref()
                .map(classify_audio_error)
                .unwrap_or("empty_recording"),
            "error": runtime_error.unwrap_or_else(|| "录音未采集到有效音频".to_string()),
        }));
    }

    if let Some(error) = runtime_error {
        return Ok(json!({
            "success": false,
            "reason": classify_audio_error(&error),
            "error": format!("录音流中途中断，请重新录制：{error}"),
            "durationMs": duration_ms,
        }));
    }

    let captured_duration_ms = if active.sample_rate == 0 || active.channels == 0 {
        0
    } else {
        samples.len() as u64 * 1000 / active.sample_rate as u64 / active.channels as u64
    };
    if duration_ms.saturating_sub(captured_duration_ms) > MAX_RECORDING_CAPTURE_DRIFT_MS {
        return Ok(json!({
            "success": false,
            "reason": "capture_duration_mismatch",
            "error": format!(
                "录音采样不完整：计时约 {:.1} 秒，实际音频约 {:.1} 秒，请重新录制",
                duration_ms as f64 / 1000.0,
                captured_duration_ms as f64 / 1000.0
            ),
            "durationMs": duration_ms,
            "capturedDurationMs": captured_duration_ms,
        }));
    }

    let bytes = encode_wav_bytes(&samples, active.sample_rate, active.channels)?;
    Ok(json!({
        "success": true,
        "clip": {
            "audioBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "mimeType": "audio/wav",
            "fileName": format!("redbox-audio-{}.wav", now_ms()),
            "durationMs": duration_ms,
            "capturedDurationMs": captured_duration_ms,
            "byteLength": bytes.len(),
            "sampleRate": active.sample_rate,
            "channels": active.channels,
            "deviceName": active.device_name,
            "strategy": "native",
        }
    }))
}

fn open_microphone_settings() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
        open::that(url).map_err(|error| error.to_string())?;
        return Ok(json!({ "success": true, "path": url }));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(json!({
            "success": false,
            "error": "当前平台暂不支持直接打开麦克风隐私设置",
        }))
    }
}

pub fn handle_audio_channel(
    _app: &AppHandle,
    _state: &State<'_, AppState>,
    channel: &str,
    _payload: &Value,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "audio:get-capture-capability" => Ok(capture_capability_value()),
        "audio:start-recording" => start_recording(),
        "audio:stop-recording" => stop_recording(false),
        "audio:cancel-recording" => stop_recording(true),
        "audio:open-microphone-settings" => open_microphone_settings(),
        _ => return None,
    };
    Some(result)
}
