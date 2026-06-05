use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct YoutubeChannelInfo {
    pub(super) channel_id: String,
    pub(super) channel_name: String,
    pub(super) description: String,
    pub(super) avatar_url: String,
}

pub(super) fn channel_info_from_ytdlp_payload(
    payload: &Value,
    fallback_channel_id: String,
    fallback_channel_name: String,
) -> YoutubeChannelInfo {
    let channel_id = payload
        .get("channel_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or(fallback_channel_id);
    let channel_name = payload
        .get("channel")
        .or_else(|| payload.get("uploader"))
        .or_else(|| payload.get("title"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or(fallback_channel_name);
    let description = payload
        .get("description")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_default();
    let avatar_url = payload
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| item.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    YoutubeChannelInfo {
        channel_id,
        channel_name,
        description,
        avatar_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_channel_info_with_fallbacks_and_latest_thumbnail() {
        let info = channel_info_from_ytdlp_payload(
            &json!({
                "channel_id": "channel-1",
                "uploader": "Uploader",
                "description": "About",
                "thumbnails": [
                    { "url": "small.jpg" },
                    { "url": "large.jpg" }
                ]
            }),
            "fallback-id".to_string(),
            "Fallback".to_string(),
        );

        assert_eq!(info.channel_id, "channel-1");
        assert_eq!(info.channel_name, "Uploader");
        assert_eq!(info.description, "About");
        assert_eq!(info.avatar_url, "large.jpg");
    }

    #[test]
    fn falls_back_when_payload_is_sparse() {
        let info = channel_info_from_ytdlp_payload(
            &json!({}),
            "fallback-id".to_string(),
            "Fallback".to_string(),
        );

        assert_eq!(
            info,
            YoutubeChannelInfo {
                channel_id: "fallback-id".to_string(),
                channel_name: "Fallback".to_string(),
                description: String::new(),
                avatar_url: String::new(),
            }
        );
    }
}
