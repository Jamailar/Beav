use super::content_blocks::parse_markdown_heading;
use super::*;

pub(super) fn normalize_manuscript_title_candidate(value: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_space = false;
    for ch in value.trim().chars() {
        let mapped = if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            '-'
        } else {
            ch
        };
        if mapped.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
            continue;
        }
        normalized.push(mapped);
        last_was_space = false;
    }
    normalized.trim().to_string()
}

pub(super) fn is_untitled_manuscript_label(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.is_empty() || normalized == "未命名" || normalized.starts_with("untitled-")
}

pub(super) fn is_auto_generated_manuscript_stem(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && (trimmed.chars().all(|ch| ch.is_ascii_digit())
            || trimmed.eq_ignore_ascii_case("untitled")
            || trimmed.to_ascii_lowercase().starts_with("untitled-"))
}

pub(super) fn first_markdown_heading_text(content: &str) -> Option<String> {
    let normalized = strip_markdown_frontmatter(content).replace("\r\n", "\n");
    normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find_map(|line| parse_markdown_heading(line).map(|(_, text)| text))
        .map(|text| normalize_manuscript_title_candidate(&text))
        .filter(|text| !text.is_empty())
}

fn build_manuscript_renamed_relative_path(
    current_relative: &str,
    current_file_name: &str,
    next_stem: &str,
) -> String {
    let parent_rel = normalize_relative_path(
        current_relative
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or(""),
    );
    let target_relative = join_relative(&parent_rel, next_stem);
    if current_file_name.ends_with(".md") && !target_relative.contains('.') {
        ensure_markdown_extension(&target_relative)
    } else {
        normalize_relative_path(&target_relative)
    }
}

pub(super) fn choose_auto_named_manuscript_relative(
    state: &State<'_, AppState>,
    current_relative: &str,
    current_file_name: &str,
    next_title: &str,
) -> Result<String, String> {
    let base_title = normalize_manuscript_title_candidate(next_title);
    if base_title.is_empty() {
        return Ok(normalize_relative_path(current_relative));
    }
    let current_normalized = normalize_relative_path(current_relative);
    let mut attempt = 0usize;
    loop {
        let candidate_title = if attempt == 0 {
            base_title.clone()
        } else {
            format!("{}-{}", base_title, attempt + 1)
        };
        let candidate_relative = build_manuscript_renamed_relative_path(
            &current_normalized,
            current_file_name,
            &candidate_title,
        );
        if candidate_relative == current_normalized {
            return Ok(candidate_relative);
        }
        let candidate_path = resolve_manuscript_path(state, &candidate_relative)?;
        if !candidate_path.exists() {
            return Ok(candidate_relative);
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_file_safe_title_candidates() {
        assert_eq!(
            normalize_manuscript_title_candidate("  A/B: C   D?  "),
            "A-B- C D-"
        );
    }

    #[test]
    fn detects_auto_named_manuscripts() {
        assert!(is_untitled_manuscript_label("Untitled-123"));
        assert!(is_auto_generated_manuscript_stem("20260606"));
        assert!(!is_auto_generated_manuscript_stem("campaign-plan"));
    }

    #[test]
    fn extracts_first_markdown_heading_as_clean_title() {
        assert_eq!(
            first_markdown_heading_text("---\na: b\n---\n\n## 商品/标题\n正文"),
            Some("商品-标题".to_string())
        );
    }

    #[test]
    fn builds_renamed_relative_paths_in_same_folder() {
        assert_eq!(
            build_manuscript_renamed_relative_path("drafts/untitled.md", "untitled.md", "新标题"),
            "drafts/新标题.md"
        );
        assert_eq!(
            build_manuscript_renamed_relative_path("drafts/package", "package", "新标题"),
            "drafts/新标题"
        );
    }
}
