use super::*;

fn last_timeline_track_name_with_prefix(timeline: &Value, prefix: char) -> Option<String> {
    timeline
        .pointer("/tracks/children")
        .and_then(Value::as_array)
        .and_then(|tracks| {
            tracks
                .iter()
                .filter_map(|track| {
                    track
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .filter(|name| name.starts_with(prefix))
                .last()
        })
}

pub(super) fn preferred_timeline_track_name(
    timeline: &Value,
    payload: &Value,
    prefix: char,
    fallback: &str,
) -> String {
    payload_string(payload, "track")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| last_timeline_track_name_with_prefix(timeline, prefix))
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn timeline_insertion_order_for_playhead(children: &[Value], playhead_ms: i64) -> usize {
    let mut desired_order = children.len();
    let mut cursor_ms = 0_i64;
    for (index, clip) in children.iter().enumerate() {
        let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
        if playhead_ms <= cursor_ms {
            desired_order = index;
            break;
        }
        desired_order = index + 1;
        cursor_ms = next_cursor_ms;
        if playhead_ms < next_cursor_ms {
            break;
        }
    }
    desired_order
}

pub(super) fn timeline_clip_insertion_for_playhead(
    children: &[Value],
    playhead_ms: i64,
) -> (usize, Option<(usize, f64)>) {
    let mut desired_order = children.len();
    let mut split_target = None;
    let mut cursor_ms = 0_i64;
    for (index, clip) in children.iter().enumerate() {
        let next_cursor_ms = cursor_ms + timeline_clip_duration_ms(clip);
        if playhead_ms > cursor_ms && playhead_ms < next_cursor_ms {
            let duration_ms = (next_cursor_ms - cursor_ms).max(1000);
            let split_ratio =
                ((playhead_ms - cursor_ms) as f64 / duration_ms as f64).clamp(0.1, 0.9);
            split_target = Some((index, split_ratio));
            desired_order = index + 1;
            break;
        }
        if playhead_ms <= cursor_ms {
            desired_order = index;
            break;
        }
        desired_order = index + 1;
        cursor_ms = next_cursor_ms;
    }
    (desired_order, split_target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(duration_ms: i64) -> Value {
        json!({
            "OTIO_SCHEMA": "Clip.2",
            "metadata": {
                "durationMs": duration_ms,
            }
        })
    }

    #[test]
    fn preferred_track_uses_payload_then_last_matching_track_then_fallback() {
        let timeline = json!({
            "tracks": {
                "children": [
                    { "name": "S1" },
                    { "name": "V1" },
                    { "name": "S2" }
                ]
            }
        });
        assert_eq!(
            preferred_timeline_track_name(&timeline, &json!({ "track": " S3 " }), 'S', "S1"),
            "S3"
        );
        assert_eq!(
            preferred_timeline_track_name(&timeline, &json!({}), 'S', "S1"),
            "S2"
        );
        assert_eq!(
            preferred_timeline_track_name(&timeline, &json!({}), 'T', "T1"),
            "T1"
        );
    }

    #[test]
    fn insertion_order_uses_playhead_against_cumulative_duration() {
        let children = vec![clip(1000), clip(2000), clip(1000)];
        assert_eq!(timeline_insertion_order_for_playhead(&children, 0), 0);
        assert_eq!(timeline_insertion_order_for_playhead(&children, 500), 1);
        assert_eq!(timeline_insertion_order_for_playhead(&children, 1000), 1);
        assert_eq!(timeline_insertion_order_for_playhead(&children, 2500), 2);
        assert_eq!(timeline_insertion_order_for_playhead(&children, 5000), 3);
    }

    #[test]
    fn clip_insertion_splits_only_inside_existing_clip() {
        let children = vec![clip(1000), clip(2000), clip(1000)];

        assert_eq!(
            timeline_clip_insertion_for_playhead(&children, 0),
            (0, None)
        );
        assert_eq!(
            timeline_clip_insertion_for_playhead(&children, 1000),
            (1, None)
        );
        assert_eq!(
            timeline_clip_insertion_for_playhead(&children, 1500),
            (2, Some((1, 0.25)))
        );
        assert_eq!(
            timeline_clip_insertion_for_playhead(&children, 5000),
            (3, None)
        );
    }
}
