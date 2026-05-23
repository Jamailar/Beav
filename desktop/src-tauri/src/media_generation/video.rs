use super::*;

pub(crate) fn map_openai_video_size(aspect_ratio: &str, resolution: &str) -> &'static str {
    match (aspect_ratio, resolution) {
        ("9:16", "1080p") => "1024x1792",
        ("9:16", _) => "720x1280",
        (_, "1080p") => "1792x1024",
        _ => "1280x720",
    }
}

pub(crate) fn map_openai_video_seconds(duration_seconds: i64) -> &'static str {
    if duration_seconds <= 6 {
        "4"
    } else if duration_seconds <= 10 {
        "8"
    } else {
        "12"
    }
}

pub(crate) fn build_video_request_body(
    endpoint: &str,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let prompt = payload_string(payload, "prompt").unwrap_or_default();
    let mut generation_mode =
        payload_string(payload, "generationMode").unwrap_or_else(|| "text-to-video".to_string());
    let reference_images = extract_reference_images(payload, 5)
        .into_iter()
        .map(|item| normalize_media_value_for_remote(&item))
        .collect::<Result<Vec<_>, _>>()?;
    let driving_audio = payload_string(payload, "drivingAudio")
        .map(|item| normalize_media_value_for_remote(&item))
        .transpose()?
        .filter(|item| !item.trim().is_empty());
    let first_clip = payload_string(payload, "firstClip")
        .map(|item| normalize_media_value_for_remote(&item))
        .transpose()?
        .filter(|item| !item.trim().is_empty());
    let aspect_ratio = normalize_video_aspect_ratio(
        payload_string(payload, "aspectRatio")
            .as_deref()
            .unwrap_or("16:9"),
    );
    let resolution = normalize_video_resolution(
        payload_string(payload, "resolution")
            .as_deref()
            .unwrap_or("720p"),
    );
    let duration_seconds = payload_video_duration_seconds(payload);
    let generate_audio = payload_field(payload, "generateAudio")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if generation_mode == "text-to-video" && !reference_images.is_empty() {
        generation_mode = "reference-guided".to_string();
    }

    let mut body = json!({
        "model": model,
        "prompt": prompt,
        "size": map_openai_video_size(aspect_ratio, resolution),
        "seconds": map_openai_video_seconds(duration_seconds),
        "n": payload_field(payload, "count").and_then(Value::as_i64).unwrap_or(1).clamp(1, 2),
        "generateAudio": generate_audio,
    });

    if is_redbox_compatible_endpoint(endpoint) {
        body["resolution"] = json!(if resolution == "1080p" {
            "1080P"
        } else {
            "720P"
        });
        body["duration"] = json!(duration_seconds);
    }

    match generation_mode.as_str() {
        "reference-guided" => {
            if !reference_images.is_empty() {
                if is_redbox_compatible_endpoint(endpoint) {
                    body["media"] = json!(reference_images
                        .iter()
                        .map(|item| json!({
                            "type": "reference_image",
                            "url": item,
                        }))
                        .collect::<Vec<_>>());
                }
                body["images"] = json!(reference_images.clone());
                body["reference_images"] = json!(reference_images.clone());
                body["reference_image_urls"] = json!(reference_images.clone());
                body["image_urls"] = json!(reference_images.clone());
                body["image"] = json!(reference_images[0].clone());
                body["image_url"] = json!(reference_images[0].clone());
                body["reference_image"] = json!(reference_images[0].clone());
                body["img_url"] = json!(reference_images[0].clone());
            }
            if let Some(driving_audio) = driving_audio.clone() {
                body["reference_voice"] = json!(driving_audio.clone());
                body["reference_voice_url"] = json!(driving_audio.clone());
                body["audio_url"] = json!(driving_audio);
            }
        }
        "first-last-frame" => {
            let first_frame = reference_images.first().cloned().unwrap_or_default();
            let last_frame = reference_images.get(1).cloned().unwrap_or_default();
            if !first_frame.is_empty() || !last_frame.is_empty() {
                body["video_mode"] = json!("first_last_frame");
                body["media"] = json!([
                    if !first_frame.is_empty() {
                        Some(json!({ "type": "first_frame", "url": first_frame.clone() }))
                    } else {
                        None
                    },
                    if !last_frame.is_empty() {
                        Some(json!({ "type": "last_frame", "url": last_frame.clone() }))
                    } else {
                        None
                    },
                    driving_audio
                        .clone()
                        .map(|audio| json!({ "type": "driving_audio", "url": audio })),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>());
                if !first_frame.is_empty() {
                    body["image"] = json!(first_frame.clone());
                    body["image_url"] = json!(first_frame.clone());
                    body["reference_image"] = json!(first_frame.clone());
                    body["img_url"] = json!(first_frame.clone());
                }
                if !last_frame.is_empty() {
                    body["images"] = json!([first_frame.clone(), last_frame.clone()]
                        .into_iter()
                        .filter(|item| !item.is_empty())
                        .collect::<Vec<_>>());
                    body["last_frame"] = json!(last_frame.clone());
                    body["last_frame_url"] = json!(last_frame.clone());
                    body["last_image_url"] = json!(last_frame);
                }
                if let Some(driving_audio) = driving_audio {
                    body["audio_url"] = json!(driving_audio.clone());
                    body["driving_audio_url"] = json!(driving_audio);
                }
            }
        }
        "continuation" => {
            if let Some(first_clip) = first_clip {
                body["video_mode"] = json!("continuation");
                body["media"] = json!([{ "type": "first_clip", "url": first_clip.clone() }]);
                body["first_clip_url"] = json!(first_clip.clone());
                body["video_url"] = json!(first_clip.clone());
                body["video"] = json!(first_clip);
            }
        }
        _ => {
            if let Some(driving_audio) = driving_audio {
                body["audio_url"] = json!(driving_audio.clone());
                body["driving_audio_url"] = json!(driving_audio);
            }
        }
    }

    Ok(body)
}

pub(crate) fn video_poll_url(endpoint: &str, task_id: &str, status_url: Option<String>) -> String {
    if let Some(status_url) = status_url {
        return status_url;
    }
    let base = normalize_base_url(endpoint);
    if base.ends_with("/tasks") {
        format!("{base}/{task_id}")
    } else if base.contains("/tasks/") {
        base
    } else {
        format!("{base}/tasks/{task_id}")
    }
}

pub(crate) fn extract_video_generation_status(value: &Value) -> String {
    value
        .get("task_status")
        .or_else(|| value.get("status"))
        .or_else(|| value.pointer("/data/task_status"))
        .or_else(|| value.pointer("/data/status"))
        .or_else(|| value.pointer("/output/task_status"))
        .or_else(|| value.pointer("/output/status"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

pub(crate) fn extract_video_generation_status_details(
    value: &Value,
) -> Option<(String, &'static str)> {
    [
        ("task_status", value.get("task_status")),
        ("status", value.get("status")),
        ("data.task_status", value.pointer("/data/task_status")),
        ("data.status", value.pointer("/data/status")),
        ("output.task_status", value.pointer("/output/task_status")),
        ("output.status", value.pointer("/output/status")),
    ]
    .into_iter()
    .find_map(|(source, item)| {
        item.and_then(Value::as_str)
            .map(str::trim)
            .filter(|status| !status.is_empty())
            .map(|status| (status.to_ascii_lowercase(), source))
    })
}

pub(crate) fn extract_video_generation_failure_message(value: &Value) -> Option<String> {
    [
        value.get("message"),
        value.get("error"),
        value.get("error_message"),
        value.get("detail"),
        value.pointer("/output/message"),
        value.pointer("/output/code"),
        value.pointer("/data/message"),
        value.pointer("/data/error"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::trim)
    .filter(|item| !item.is_empty())
    .map(ToString::to_string)
}

pub(crate) fn summarize_json_body(value: &Value) -> String {
    let raw = match value {
        Value::String(text) => text.trim().to_string(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }
    let snippet = trimmed.chars().take(400).collect::<String>();
    if snippet.chars().count() == trimmed.chars().count() {
        snippet
    } else {
        format!("{snippet}...")
    }
}

pub(crate) fn poll_video_generation_result<F>(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    response: &Value,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(&str),
{
    if let Some(url) = extract_media_url(response) {
        on_progress("provider 已直接返回视频地址，跳过轮询。");
        return Ok(url);
    }
    let (task_id, task_id_source) = extract_task_id_details(response)
        .ok_or_else(|| "video generation response did not include a task id".to_string())?;
    on_progress(&format!(
        "provider 已创建异步任务，task_id={task_id}，来源字段={task_id_source}。"
    ));
    if task_id_source == "id" {
        on_progress(
            "provider 只返回了通用 id 字段，当前按 task_id 继续轮询；如果后续异常，这里是首要怀疑点。",
        );
    }
    let max_attempts = (VIDEO_TASK_POLL_TIMEOUT_MS / VIDEO_TASK_POLL_INTERVAL_MS) as usize;
    let sleep_duration = std::time::Duration::from_millis(VIDEO_TASK_POLL_INTERVAL_MS);
    let mut last_transport_error: Option<String> = None;
    if is_redbox_compatible_endpoint(endpoint) {
        let query_urls =
            build_compatible_video_route_urls(endpoint, "/videos/generations/tasks/query");
        on_progress("开始轮询 provider 任务状态（POST /videos/generations/tasks/query）。");
        for attempt_index in 0..max_attempts {
            thread::sleep(sleep_duration);
            let attempt = attempt_index + 1;
            let mut attempt_transport_error: Option<String> = None;
            let mut logged_status = false;
            for query_url in &query_urls {
                match run_curl_json_response(
                    "POST",
                    query_url,
                    api_key,
                    &[],
                    Some(json!({
                        "model": model,
                        "task_id": task_id,
                    })),
                    None,
                ) {
                    Ok(response) => {
                        if !(200..300).contains(&response.status) {
                            let message = format!(
                                "[{query_url}] HTTP {} {}",
                                response.status,
                                summarize_json_body(&response.body)
                            );
                            last_transport_error = Some(message.clone());
                            attempt_transport_error = Some(message.clone());
                            if response.status != 404 {
                                on_progress(&format!("poll#{attempt} api_error={message}"));
                                return Err(message);
                            }
                            continue;
                        }
                        let next = response.body;
                        if !logged_status {
                            if let Some((status, source)) =
                                extract_video_generation_status_details(&next)
                            {
                                on_progress(&format!(
                                    "poll#{attempt} api_status[{source}]={status}"
                                ));
                            } else {
                                on_progress(&format!("poll#{attempt} api_status=<missing>"));
                            }
                            logged_status = true;
                        }
                        if let Some(url) = extract_media_url(&next) {
                            on_progress(&format!("poll#{attempt} media_url_ready=true"));
                            return Ok(url);
                        }
                        let status = extract_video_generation_status(&next);
                        if status.contains("failed")
                            || status.contains("error")
                            || status.contains("cancel")
                        {
                            let message = extract_video_generation_failure_message(&next)
                                .unwrap_or_else(|| {
                                    format!("video generation failed with status {status}")
                                });
                            on_progress(&format!("provider 任务失败：{message}"));
                            return Err(message);
                        }
                    }
                    Err(error) => {
                        let message = format!("[{query_url}] {error}");
                        last_transport_error = Some(message.clone());
                        attempt_transport_error = Some(message);
                    }
                }
            }
            if !logged_status {
                if let Some(error) = attempt_transport_error.as_deref() {
                    on_progress(&format!("poll#{attempt} api_error={error}"));
                } else {
                    on_progress(&format!("poll#{attempt} api_status=<missing>"));
                }
            }
        }
        let timeout_error = last_transport_error.unwrap_or_else(|| {
            format!(
                "video generation timed out after {} seconds (task_id={task_id})",
                VIDEO_TASK_POLL_TIMEOUT_MS / 1000
            )
        });
        on_progress(&format!("轮询超时：{timeout_error}"));
        return Err(timeout_error);
    }
    let status_url = extract_status_url(response);
    let poll_url = video_poll_url(endpoint, &task_id, status_url);
    on_progress(&format!("开始轮询 provider 任务状态（GET {poll_url}）。"));
    for attempt_index in 0..max_attempts {
        thread::sleep(sleep_duration);
        let attempt = attempt_index + 1;
        match run_curl_json_response("GET", &poll_url, api_key, &[], None, None) {
            Ok(response) => {
                if !(200..300).contains(&response.status) {
                    let message = format!(
                        "[{poll_url}] HTTP {} {}",
                        response.status,
                        summarize_json_body(&response.body)
                    );
                    on_progress(&format!("poll#{attempt} api_error={message}"));
                    return Err(message);
                }
                let next = response.body;
                if let Some((status, source)) = extract_video_generation_status_details(&next) {
                    on_progress(&format!("poll#{attempt} api_status[{source}]={status}"));
                } else {
                    on_progress(&format!("poll#{attempt} api_status=<missing>"));
                }
                if let Some(url) = extract_media_url(&next) {
                    on_progress(&format!("poll#{attempt} media_url_ready=true"));
                    return Ok(url);
                }
                let status = extract_video_generation_status(&next);
                if status.contains("failed")
                    || status.contains("error")
                    || status.contains("cancel")
                {
                    let message = extract_video_generation_failure_message(&next)
                        .unwrap_or_else(|| format!("video generation failed with status {status}"));
                    on_progress(&format!("provider 任务失败：{message}"));
                    return Err(message);
                }
            }
            Err(error) => {
                last_transport_error = Some(error);
                on_progress(&format!(
                    "poll#{attempt} api_error={}",
                    last_transport_error.as_deref().unwrap_or_default()
                ));
            }
        }
    }
    let timeout_error = last_transport_error.unwrap_or_else(|| {
        format!(
            "video generation timed out after {} seconds (task_id={task_id})",
            VIDEO_TASK_POLL_TIMEOUT_MS / 1000
        )
    });
    on_progress(&format!("轮询超时：{timeout_error}"));
    Err(timeout_error)
}

pub(crate) fn run_video_generation_request(
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    payload: &Value,
) -> Result<Value, String> {
    let create_urls = build_compatible_video_route_urls(endpoint, "/videos/generations/async");
    let body = build_video_request_body(endpoint, model, payload)?;
    let mut last_error = None;
    for url in create_urls {
        match run_curl_json_response("POST", &url, api_key, &[], Some(body.clone()), None) {
            Ok(response) => {
                if (200..300).contains(&response.status) {
                    return Ok(response.body);
                }
                let error = format!(
                    "[{url}] HTTP {} {}",
                    response.status,
                    summarize_json_body(&response.body)
                );
                if response.status != 404 {
                    return Err(error);
                }
                last_error = Some(error);
            }
            Err(error) => last_error = Some(format!("[{url}] {error}")),
        }
    }
    Err(last_error.unwrap_or_else(|| "video generation request failed".to_string()))
}
