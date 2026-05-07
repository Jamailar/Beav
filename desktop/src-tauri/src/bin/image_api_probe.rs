use base64::Engine;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const HTTP_STATUS_MARKER: &str = "__REDBOX_HTTP_STATUS__:";

#[derive(Debug, Clone)]
struct ProbeConfig {
    state_path: PathBuf,
    endpoint: String,
    api_key: Option<String>,
    model: String,
    provider: String,
    template: String,
    size: String,
    quality: String,
    count: i64,
    max_time_seconds: u64,
    output_dir: PathBuf,
    suite_name: String,
    custom_prompt: Option<String>,
    custom_language: String,
    custom_slug: String,
}

#[derive(Debug)]
struct AttemptResult {
    transport: &'static str,
    exit_status: String,
    http_status: Option<u16>,
    stdout: String,
    stderr: String,
    parsed_body: Option<String>,
}

#[derive(Debug, Clone)]
struct ProbeCase {
    slug: String,
    language: String,
    prompt: String,
}

fn main() {
    if let Err(error) = real_main() {
        eprintln!("image_api_probe failed: {error}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<(), String> {
    let config = load_probe_config()?;
    let cases = resolve_probe_cases(&config);
    if cases.is_empty() {
        return Err(format!("no probe cases for suite {}", config.suite_name));
    }

    println!("== Image API Probe ==");
    println!("state_path={}", config.state_path.display());
    println!("endpoint={}", config.endpoint);
    println!("provider={}", config.provider);
    println!("template={}", config.template);
    println!("model={}", config.model);
    println!("api_key={}", mask_secret(config.api_key.as_deref()));
    println!("size={}", config.size);
    println!("quality={}", config.quality);
    println!("count={}", config.count);
    println!("max_time_seconds={}", config.max_time_seconds);
    println!("suite={}", config.suite_name);
    println!("output_dir={}", config.output_dir.display());
    println!();

    let request_url = resolve_request_url(&config.endpoint, &config.template);
    println!("request_url={request_url}");
    println!("cases={}", cases.len());
    println!();

    fs::create_dir_all(&config.output_dir)
        .map_err(|error| format!("failed to create {}: {error}", config.output_dir.display()))?;

    let mut success_count = 0usize;
    for (index, case) in cases.iter().enumerate() {
        println!(
            "== Case {}/{}: {} ({}) ==",
            index + 1,
            cases.len(),
            case.slug,
            case.language
        );
        println!("prompt={}", case.prompt);
        let request_body = build_request_body(&config, case);
        println!(
            "request_body={}",
            serde_json::to_string_pretty(&request_body).map_err(|error| error.to_string())?
        );

        let default_attempt = run_curl_attempt(&config, &request_url, &request_body, false)?;
        print_attempt(&default_attempt);
        if let Some(path) = try_write_image_artifact(&config.output_dir, case, &default_attempt)? {
            println!("saved_image={}", path.display());
            success_count += 1;
            println!();
            continue;
        }

        println!();
        let http11_attempt = run_curl_attempt(&config, &request_url, &request_body, true)?;
        print_attempt(&http11_attempt);
        if let Some(path) = try_write_image_artifact(&config.output_dir, case, &http11_attempt)? {
            println!("saved_image={}", path.display());
            success_count += 1;
        }
        println!();
    }

    println!(
        "summary: success_cases={} total_cases={} output_dir={}",
        success_count,
        cases.len(),
        config.output_dir.display()
    );
    if success_count == 0 {
        return Err("no case returned a writable image artifact".to_string());
    }
    Ok(())
}

fn load_probe_config() -> Result<ProbeConfig, String> {
    let mut state_path = default_state_path()?;
    let mut size = "1024x1024".to_string();
    let mut quality_override: Option<String> = None;
    let mut count = 1_i64;
    let mut max_time_seconds = 90_u64;
    let mut suite_name = "multilingual".to_string();
    let mut output_dir: Option<PathBuf> = None;
    let mut custom_prompt: Option<String> = None;
    let mut custom_language = "custom".to_string();
    let mut custom_slug = "custom".to_string();

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--state-path" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--state-path requires a value".to_string())?;
                state_path = PathBuf::from(value);
            }
            "--size" => {
                size = args
                    .next()
                    .ok_or_else(|| "--size requires a value".to_string())?;
            }
            "--quality" => {
                quality_override = Some(
                    args.next()
                        .ok_or_else(|| "--quality requires a value".to_string())?,
                );
            }
            "--count" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--count requires a value".to_string())?;
                count = value
                    .parse::<i64>()
                    .map_err(|error| format!("invalid --count: {error}"))?;
            }
            "--max-time" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--max-time requires a value".to_string())?;
                max_time_seconds = value
                    .parse::<u64>()
                    .map_err(|error| format!("invalid --max-time: {error}"))?;
            }
            "--suite" => {
                suite_name = args
                    .next()
                    .ok_or_else(|| "--suite requires a value".to_string())?;
            }
            "--prompt" => {
                custom_prompt = Some(
                    args.next()
                        .ok_or_else(|| "--prompt requires a value".to_string())?,
                );
            }
            "--language" => {
                custom_language = args
                    .next()
                    .ok_or_else(|| "--language requires a value".to_string())?;
            }
            "--slug" => {
                custom_slug = args
                    .next()
                    .ok_or_else(|| "--slug requires a value".to_string())?;
            }
            "--output-dir" => {
                output_dir =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        "--output-dir requires a value".to_string()
                    })?));
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let store_text = fs::read_to_string(&state_path)
        .map_err(|error| format!("failed to read {}: {error}", state_path.display()))?;
    let store_value: Value = serde_json::from_str(&store_text)
        .map_err(|error| format!("invalid store json: {error}"))?;
    let settings = store_value
        .get("settings")
        .ok_or_else(|| "redbox-state.json missing settings".to_string())?;

    let endpoint = payload_string(settings, "image_endpoint")
        .or_else(|| payload_string(settings, "api_endpoint"))
        .ok_or_else(|| "missing image_endpoint/api_endpoint in settings".to_string())?;
    let model = payload_string(settings, "image_model")
        .ok_or_else(|| "missing image_model in settings".to_string())?;
    let provider = payload_string(settings, "image_provider")
        .unwrap_or_else(|| "openai-compatible".to_string());
    let template = payload_string(settings, "image_provider_template")
        .unwrap_or_else(|| "openai-images".to_string());
    let api_key =
        payload_string(settings, "image_api_key").or_else(|| payload_string(settings, "api_key"));
    let quality = quality_override
        .or_else(|| payload_string(settings, "image_quality"))
        .unwrap_or_else(|| "auto".to_string());
    let output_dir = output_dir.unwrap_or_else(|| default_output_dir(&suite_name));

    Ok(ProbeConfig {
        state_path,
        endpoint,
        api_key,
        model,
        provider,
        template,
        size,
        quality,
        count: count.clamp(1, 4),
        max_time_seconds,
        output_dir,
        suite_name,
        custom_prompt,
        custom_language,
        custom_slug,
    })
}

fn print_help() {
    println!("Usage: cargo run --bin image_api_probe -- [options]");
    println!("  --state-path <path>   Override redbox-state.json path");
    println!("  --suite <name>        Probe suite name, default multilingual");
    println!("  --size <WxH>          Override image size, default 1024x1024");
    println!("  --quality <value>     Override quality, default current settings.image_quality");
    println!("  --count <n>           Override count, default 1");
    println!("  --max-time <sec>      Override curl max time, default 90");
    println!("  --prompt <text>       Run a single custom prompt instead of a named suite");
    println!("  --language <name>     Label for --prompt case, default custom");
    println!("  --slug <value>        Output slug for --prompt case, default custom");
    println!("  --output-dir <path>   Override artifact output directory");
}

fn default_state_path() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .or_else(dirs::config_dir)
        .ok_or_else(|| "failed to resolve data/config dir".to_string())?;
    Ok(base.join("RedBox").join("redbox-state.json"))
}

fn default_output_dir(suite_name: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    dirs::data_dir()
        .unwrap_or_else(env::temp_dir)
        .join("RedBox")
        .join("probes")
        .join("image-api")
        .join(format!("{suite_name}-{timestamp}"))
}

fn payload_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .and_then(|raw| {
            if raw.is_empty() {
                None
            } else {
                Some(raw.to_string())
            }
        })
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn resolve_request_url(endpoint: &str, template: &str) -> String {
    let base = normalize_base_url(endpoint);
    match template.trim().to_ascii_lowercase().as_str() {
        "openai-images" | "" => {
            if base.ends_with("/images/generations") {
                base
            } else {
                format!("{base}/images/generations")
            }
        }
        _ => base,
    }
}

fn build_probe_cases(suite_name: &str) -> Vec<ProbeCase> {
    match suite_name.trim().to_ascii_lowercase().as_str() {
        "multilingual" | "" => vec![
            ProbeCase {
                slug: "zh-cn".to_string(),
                language: "Chinese".to_string(),
                prompt: "一个红色立方体放在纯白无缝背景上，居中构图，柔和投影，产品摄影灯光。".to_string(),
            },
            ProbeCase {
                slug: "en".to_string(),
                language: "English".to_string(),
                prompt: "A single red cube on a pure white seamless background, centered composition, soft shadow, product-photo lighting.".to_string(),
            },
            ProbeCase {
                slug: "ja".to_string(),
                language: "Japanese".to_string(),
                prompt: "真っ白な背景の中央に赤い立方体を1つ配置し、柔らかい影と商品撮影のような照明で表現してください。".to_string(),
            },
            ProbeCase {
                slug: "ar".to_string(),
                language: "Arabic".to_string(),
                prompt: "مكعب أحمر واحد في منتصف خلفية بيضاء ناعمة، بإضاءة تصوير منتجات وظل خفيف.".to_string(),
            },
        ],
        other => vec![ProbeCase {
            slug: "custom".to_string(),
            language: other.to_string(),
            prompt: other.to_string(),
        }],
    }
}

fn resolve_probe_cases(config: &ProbeConfig) -> Vec<ProbeCase> {
    if let Some(prompt) = config
        .custom_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return vec![ProbeCase {
            slug: config.custom_slug.trim().to_string(),
            language: config.custom_language.trim().to_string(),
            prompt: prompt.to_string(),
        }];
    }
    build_probe_cases(&config.suite_name)
}

fn normalize_quality_for_probe(raw: &str) -> Option<String> {
    match raw.trim() {
        "" | "auto" | "standard" => None,
        other => Some(other.to_string()),
    }
}

fn build_request_body(config: &ProbeConfig, case: &ProbeCase) -> Value {
    let mut body = json!({
        "model": config.model,
        "prompt": case.prompt,
        "n": config.count,
        "response_format": "b64_json"
    });
    if let Some(body_object) = body.as_object_mut() {
        if !config.size.trim().is_empty() {
            body_object.insert("size".to_string(), json!(config.size));
        }
        if let Some(quality) = normalize_quality_for_probe(&config.quality) {
            body_object.insert("quality".to_string(), json!(quality));
        }
    }
    body
}

fn run_curl_attempt(
    config: &ProbeConfig,
    request_url: &str,
    request_body: &Value,
    force_http1_1: bool,
) -> Result<AttemptResult, String> {
    let mut command = Command::new("curl");
    command.arg("-sS").arg("-X").arg("POST").arg(request_url);
    if force_http1_1 {
        command.arg("--http1.1");
    }
    command
        .arg("--max-time")
        .arg(config.max_time_seconds.to_string())
        .arg("-H")
        .arg("Content-Type: application/json");
    if let Some(api_key) = config
        .api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command
            .arg("-H")
            .arg(format!("Authorization: Bearer {api_key}"));
    }
    command
        .arg("--data-binary")
        .arg("@-")
        .arg("-w")
        .arg(format!("\n{HTTP_STATUS_MARKER}%{{http_code}}"));
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let payload = serde_json::to_vec(request_body).map_err(|error| error.to_string())?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn curl: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "curl stdin unavailable".to_string())?;
    stdin
        .write_all(&payload)
        .map_err(|error| format!("failed to write curl stdin: {error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to wait for curl: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let (parsed_body, http_status) = split_http_trailer(&stdout);

    Ok(AttemptResult {
        transport: if force_http1_1 { "http1.1" } else { "default" },
        exit_status: output.status.to_string(),
        http_status,
        stdout,
        stderr,
        parsed_body,
    })
}

fn split_http_trailer(stdout: &str) -> (Option<String>, Option<u16>) {
    let Some((body_text, status_text)) = stdout.rsplit_once(HTTP_STATUS_MARKER) else {
        return (None, None);
    };
    let status = status_text.trim().parse::<u16>().ok();
    let body = body_text.trim().to_string();
    (Some(body), status)
}

fn print_attempt(result: &AttemptResult) {
    println!("== Attempt: {} ==", result.transport);
    println!("exit_status={}", result.exit_status);
    println!(
        "http_status={}",
        result
            .http_status
            .map(|value| value.to_string())
            .unwrap_or_else(|| "<missing>".to_string())
    );
    println!("stderr={}", summarize_text(&result.stderr, 2000));
    match result.parsed_body.as_deref() {
        Some(body) => println!("body={}", summarize_json_or_text(body, 6000)),
        None => println!("stdout={}", summarize_text(&result.stdout, 3000)),
    }
}

fn try_write_image_artifact(
    output_dir: &PathBuf,
    case: &ProbeCase,
    result: &AttemptResult,
) -> Result<Option<PathBuf>, String> {
    let Some(body) = result.parsed_body.as_deref() else {
        return Ok(None);
    };
    let parsed = match serde_json::from_str::<Value>(body) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let item = parsed
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .or_else(|| parsed.get("result"))
        .or_else(|| parsed.get("output"))
        .unwrap_or(&parsed);

    if let Some(encoded) = find_string_field(item, &["b64_json", "b64", "image_base64"]) {
        let bytes = decode_base64(encoded)?;
        let ext = infer_extension(&bytes);
        let path = output_dir.join(format!("{}-{}.{}", case.slug, result.transport, ext));
        fs::write(&path, bytes)
            .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
        return Ok(Some(path));
    }

    if let Some(url) = find_string_field(item, &["url", "image_url"]) {
        let bytes = download_url(url)?;
        let ext = infer_extension(&bytes);
        let path = output_dir.join(format!("{}-{}.{}", case.slug, result.transport, ext));
        fs::write(&path, bytes)
            .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
        return Ok(Some(path));
    }

    Ok(None)
}

fn find_string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

fn decode_base64(raw: &str) -> Result<Vec<u8>, String> {
    let normalized = raw
        .trim()
        .replace('\n', "")
        .replace('\r', "")
        .replace(' ', "");
    base64::engine::general_purpose::STANDARD
        .decode(normalized.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(normalized.as_bytes()))
        .map_err(|error| format!("invalid base64 image payload: {error}"))
}

fn download_url(url: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("curl")
        .arg("-sS")
        .arg("-L")
        .arg(url)
        .output()
        .map_err(|error| format!("failed to download image url: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "image url download failed: {} {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn infer_extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else {
        "bin"
    }
}

fn summarize_json_or_text(raw: &str, limit: usize) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        summarize_value(&value, limit)
    } else {
        summarize_text(raw, limit)
    }
}

fn summarize_value(value: &Value, limit: usize) -> String {
    fn redact(value: &Value) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
            Value::Object(map) => {
                let mut next = serde_json::Map::new();
                for (key, item) in map {
                    next.insert(key.clone(), redact(item));
                }
                Value::Object(next)
            }
            Value::String(text) => {
                if text.len() > 160 {
                    Value::String(format!("<{} chars>", text.len()))
                } else {
                    Value::String(text.clone())
                }
            }
            _ => value.clone(),
        }
    }

    let raw = serde_json::to_string_pretty(&redact(value)).unwrap_or_else(|_| value.to_string());
    summarize_text(&raw, limit)
}

fn summarize_text(raw: &str, limit: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }
    let mut chars = trimmed.chars();
    let snippet: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{snippet}...")
    } else {
        snippet
    }
}

fn mask_secret(value: Option<&str>) -> String {
    let Some(value) = value.map(str::trim).filter(|item| !item.is_empty()) else {
        return "<empty>".to_string();
    };
    if value.len() <= 8 {
        return format!("<{} chars>", value.len());
    }
    format!("{}***{}", &value[..4], &value[value.len() - 4..])
}
