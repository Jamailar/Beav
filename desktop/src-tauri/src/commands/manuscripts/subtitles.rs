#[derive(Clone)]
pub(super) struct SrtSegment {
    pub(super) start_ms: i64,
    pub(super) end_ms: i64,
    pub(super) text: String,
}

fn parse_srt_timestamp(value: &str) -> Option<i64> {
    let normalized = value.trim().replace('.', ",");
    let mut parts = normalized.split(':');
    let hours = parts.next()?.trim().parse::<i64>().ok()?;
    let minutes = parts.next()?.trim().parse::<i64>().ok()?;
    let seconds_and_millis = parts.next()?.trim();
    if parts.next().is_some() {
        return None;
    }
    let (seconds, millis) = seconds_and_millis.split_once(',')?;
    let seconds = seconds.trim().parse::<i64>().ok()?;
    let millis = millis.trim().parse::<i64>().ok()?;
    Some((((hours * 60 + minutes) * 60 + seconds) * 1000) + millis)
}

pub(super) fn parse_srt_segments(content: &str) -> Vec<SrtSegment> {
    content
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|block| {
            let lines = block
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>();
            if lines.is_empty() {
                return None;
            }
            let timing_line_index = lines.iter().position(|line| line.contains("-->"))?;
            let timing_line = lines.get(timing_line_index)?;
            let (start_raw, end_raw) = timing_line.split_once("-->")?;
            let start_ms = parse_srt_timestamp(start_raw)?;
            let end_ms = parse_srt_timestamp(end_raw)?;
            if end_ms <= start_ms {
                return None;
            }
            let text = lines
                .iter()
                .skip(timing_line_index + 1)
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            if text.is_empty() {
                return None;
            }
            Some(SrtSegment {
                start_ms,
                end_ms,
                text,
            })
        })
        .collect()
}

fn format_srt_timestamp(value_ms: i64) -> String {
    let safe = value_ms.max(0);
    let hours = safe / 3_600_000;
    let minutes = (safe % 3_600_000) / 60_000;
    let seconds = (safe % 60_000) / 1000;
    let millis = safe % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

pub(super) fn serialize_srt_segments(segments: &[SrtSegment]) -> String {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            format!(
                "{}\n{} --> {}\n{}",
                index + 1,
                format_srt_timestamp(segment.start_ms),
                format_srt_timestamp(segment.end_ms),
                segment.text.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn build_fallback_srt_segments(transcript: &str, duration_ms: i64) -> Vec<SrtSegment> {
    let normalized = transcript.trim();
    if normalized.is_empty() {
        return Vec::new();
    }
    vec![SrtSegment {
        start_ms: 0,
        end_ms: duration_ms.max(800),
        text: normalized.to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_serializes_srt_segments() {
        let segments = parse_srt_segments(
            "1\n00:00:01,250 --> 00:00:02,500\n第一行\n第二行\n\n2\n00:00:03.000 --> 00:00:04.100\n结尾",
        );

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_ms, 1250);
        assert_eq!(segments[0].end_ms, 2500);
        assert_eq!(segments[0].text, "第一行\n第二行");
        assert_eq!(
            serialize_srt_segments(&segments),
            "1\n00:00:01,250 --> 00:00:02,500\n第一行\n第二行\n\n2\n00:00:03,000 --> 00:00:04,100\n结尾"
        );
    }

    #[test]
    fn fallback_srt_segment_uses_minimum_duration() {
        let segments = build_fallback_srt_segments("  转写文本  ", 100);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 800);
        assert_eq!(segments[0].text, "转写文本");
    }
}
