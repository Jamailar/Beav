use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegalMetadata {
    pub jurisdiction: Option<String>,
    pub authority: Option<String>,
    pub authority_level: Option<i64>,
    pub effective_date: Option<String>,
    pub expiry_date: Option<String>,
    pub document_type: Option<String>,
    #[serde(default)]
    pub is_superseded: bool,
}

pub(crate) fn extract_legal_metadata(
    title: Option<&str>,
    relative_path: &str,
    source_type: &str,
    blocks_text: &str,
) -> LegalMetadata {
    let preview = blocks_text.chars().take(4_000).collect::<String>();
    let combined = format!(
        "{}\n{}\n{}\n{}",
        title.unwrap_or_default(),
        relative_path,
        source_type,
        preview
    );
    let lower = combined.to_lowercase();
    let document_type = detect_document_type(title, relative_path, source_type, &combined, &lower);
    let authority = detect_authority(&combined, &lower);
    let jurisdiction = detect_jurisdiction(&combined, &lower);
    let effective_date = extract_effective_date(&combined, &lower);
    let expiry_date = extract_expiry_date(&combined, &lower);
    let is_superseded = detect_superseded(&combined, &lower);
    let authority_level = Some(compute_authority_level(
        authority.as_deref(),
        jurisdiction.as_deref(),
        document_type.as_deref(),
    ));

    LegalMetadata {
        jurisdiction,
        authority,
        authority_level,
        effective_date,
        expiry_date,
        document_type,
        is_superseded,
    }
}

fn detect_document_type(
    title: Option<&str>,
    relative_path: &str,
    source_type: &str,
    combined: &str,
    lower: &str,
) -> Option<String> {
    let title_text = title.unwrap_or_default();
    let title_lower = title_text.to_lowercase();
    let path_lower = relative_path.to_lowercase();
    let type_lower = source_type.to_lowercase();
    let title_scope = format!("{title_lower}\n{path_lower}");

    if contains_any(
        &title_scope,
        &[
            "解读",
            "评析",
            "评论",
            "释义",
            "指引",
            "问答",
            "指南",
            "commentary",
            "analysis",
            "overview",
            "faq",
            "guide",
        ],
    ) {
        return Some("commentary".to_string());
    }
    if contains_any(
        &title_scope,
        &[
            "司法解释",
            "法释",
            "judicial interpretation",
            "supreme court interpretation",
        ],
    ) {
        return Some("judicial-interpretation".to_string());
    }
    if contains_any(
        &title_scope,
        &[
            "条例",
            "办法",
            "规定",
            "细则",
            "规则",
            "regulation",
            "ordinance",
            "measure",
            "directive",
        ],
    ) {
        return Some("regulation".to_string());
    }
    if contains_any(&title_scope, &["法", "act", "code", "law", "statute"])
        || contains_any(
            &title_scope,
            &["民法典", "刑法", "civil code", "criminal law"],
        )
    {
        return Some("law".to_string());
    }
    if contains_any(
        &title_scope,
        &[
            "判决书",
            "裁定书",
            "案例",
            "guiding case",
            "judgment",
            "opinion",
            "v.",
        ],
    ) {
        return Some("case".to_string());
    }
    if contains_any(
        &title_scope,
        &["合同", "协议", "agreement", "contract", "nda", "msa"],
    ) {
        return Some("contract".to_string());
    }
    if contains_any(
        lower,
        &[
            "判决书",
            "裁定书",
            "案例",
            "指导案例",
            "judgment",
            "opinion",
            "v.",
            "case no.",
            "case ",
        ],
    ) {
        return Some("case".to_string());
    }
    if contains_any(
        lower,
        &["合同", "协议", "agreement", "contract", "nda", "msa"],
    ) {
        return Some("contract".to_string());
    }
    if contains_any(
        lower,
        &[
            "司法解释",
            "法释",
            "judicial interpretation",
            "supreme court interpretation",
        ],
    ) {
        return Some("judicial-interpretation".to_string());
    }
    if contains_any(
        lower,
        &[
            "条例",
            "办法",
            "规定",
            "细则",
            "规则",
            "regulation",
            "ordinance",
            "rule ",
            "rules ",
            "measure",
            "directive",
        ],
    ) {
        return Some("regulation".to_string());
    }
    if contains_any(lower, &["民法典", "刑法", "civil code", "criminal law"])
        || contains_any(lower, &[" act ", " code ", " law ", " statute "])
    {
        return Some("law".to_string());
    }
    if type_lower == "eml"
        || contains_any(
            lower,
            &[
                "制度", "手册", "规范", "政策", "policy", "manual", "playbook",
            ],
        )
    {
        return Some("internal-policy".to_string());
    }
    if !combined.trim().is_empty() {
        return Some("general".to_string());
    }
    None
}

fn detect_jurisdiction(combined: &str, lower: &str) -> Option<String> {
    if contains_any(
        combined,
        &[
            "中华人民共和国",
            "全国人民代表大会",
            "国务院",
            "最高人民法院",
            "最高人民检察院",
        ],
    ) {
        return Some("CN-national".to_string());
    }
    if let Some(value) = chinese_region_regex()
        .captures(combined)
        .and_then(|caps| caps.get(1).map(|value| value.as_str().to_string()))
    {
        return Some(value);
    }
    if contains_any(
        lower,
        &["united states", "u.s.", "federal register", "federal"],
    ) {
        return Some("US-federal".to_string());
    }
    if let Some(value) = english_region_regex().captures(lower).and_then(|caps| {
        caps.get(1)
            .map(|value| format!("US-{}", title_case(value.as_str())))
    }) {
        return Some(value);
    }
    None
}

fn detect_authority(combined: &str, lower: &str) -> Option<String> {
    for fixed in [
        "全国人民代表大会常务委员会",
        "全国人民代表大会",
        "国务院",
        "最高人民法院",
        "最高人民检察院",
        "司法部",
        "财政部",
        "中国证券监督管理委员会",
        "国家市场监督管理总局",
    ] {
        if combined.contains(fixed) {
            return Some(fixed.to_string());
        }
    }
    if let Some(value) = chinese_authority_regex()
        .captures(combined)
        .and_then(|caps| caps.get(1).map(|value| value.as_str().to_string()))
    {
        return Some(value);
    }
    if contains_any(lower, &["supreme court", "court of appeals"]) {
        return Some("Court".to_string());
    }
    if let Some(value) = english_authority_regex()
        .captures(lower)
        .and_then(|caps| caps.get(1).map(|value| title_case(value.as_str())))
    {
        return Some(value);
    }
    None
}

fn detect_superseded(combined: &str, lower: &str) -> bool {
    contains_any(
        combined,
        &["已废止", "废止", "失效", "作废", "旧版", "历史版本"],
    ) || contains_any(
        lower,
        &["superseded", "repealed", "rescinded", "expired", "obsolete"],
    )
}

fn compute_authority_level(
    authority: Option<&str>,
    jurisdiction: Option<&str>,
    document_type: Option<&str>,
) -> i64 {
    let base = match document_type.unwrap_or("general") {
        "law" => 120,
        "regulation" => 100,
        "judicial-interpretation" => 98,
        "case" => 85,
        "contract" => 60,
        "internal-policy" => 45,
        "commentary" => 30,
        _ => 20,
    };
    let authority_bonus = match authority.unwrap_or_default() {
        "全国人民代表大会常务委员会" | "全国人民代表大会" => 24,
        "国务院" => 20,
        "最高人民法院" | "最高人民检察院" => 18,
        _ if authority
            .is_some_and(|value| value.contains("人民政府") || value.contains("委员会")) =>
        {
            10
        }
        _ if authority.is_some_and(|value| value.contains("法院")) => 8,
        _ => 0,
    };
    let jurisdiction_bonus = match jurisdiction.unwrap_or_default() {
        "CN-national" | "US-federal" => 10,
        _ if jurisdiction.is_some_and(|value| {
            value.contains('省') || value.contains('市') || value.starts_with("US-")
        }) =>
        {
            5
        }
        _ => 0,
    };
    base + authority_bonus + jurisdiction_bonus
}

fn extract_effective_date(combined: &str, lower: &str) -> Option<String> {
    extract_date_with_keywords(
        combined,
        lower,
        &["施行", "生效", "自", "effective", "effective date"],
        false,
    )
}

fn extract_expiry_date(combined: &str, lower: &str) -> Option<String> {
    extract_date_with_keywords(
        combined,
        lower,
        &[
            "废止",
            "失效",
            "截至",
            "有效期至",
            "until",
            "expires",
            "expired",
        ],
        true,
    )
}

fn extract_date_with_keywords(
    combined: &str,
    lower: &str,
    keywords: &[&str],
    prefer_last: bool,
) -> Option<String> {
    for keyword in keywords {
        if let Some(index) = lower.find(&keyword.to_lowercase()) {
            if let Some(window) = char_context_window(combined, index, 24, 48) {
                let date = if prefer_last {
                    extract_last_date(window)
                } else {
                    extract_first_date(window)
                };
                if let Some(date) = date {
                    return Some(date);
                }
            }
        }
    }
    if prefer_last {
        extract_last_date(combined)
    } else {
        extract_first_date(combined)
    }
}

fn char_context_window(
    input: &str,
    center_byte: usize,
    chars_before: usize,
    chars_after: usize,
) -> Option<&str> {
    let start_byte = rewind_char_boundary(input, center_byte, chars_before)?;
    let end_byte = forward_char_boundary(input, center_byte, chars_after)?;
    Some(&input[start_byte..end_byte])
}

fn rewind_char_boundary(input: &str, start_byte: usize, char_len: usize) -> Option<usize> {
    if start_byte >= input.len() || !input.is_char_boundary(start_byte) {
        return None;
    }
    let prefix = &input[..start_byte];
    let mut indices = prefix
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    indices.push(start_byte);
    let start_index = indices.len().saturating_sub(char_len + 1);
    indices.get(start_index).copied()
}

fn forward_char_boundary(input: &str, start_byte: usize, char_len: usize) -> Option<usize> {
    if start_byte >= input.len() || !input.is_char_boundary(start_byte) {
        return None;
    }
    let mut count = 0usize;
    for (offset, _) in input[start_byte..].char_indices() {
        if count == char_len {
            return Some(start_byte + offset);
        }
        count += 1;
    }
    Some(input.len())
}

fn extract_first_date(input: &str) -> Option<String> {
    date_regex()
        .captures_iter(input)
        .next()
        .and_then(capture_to_date)
}

fn extract_last_date(input: &str) -> Option<String> {
    date_regex()
        .captures_iter(input)
        .last()
        .and_then(capture_to_date)
}

fn capture_to_date(caps: regex::Captures<'_>) -> Option<String> {
    Some(format_date_capture(&caps)?)
}

fn format_date_capture(caps: &regex::Captures<'_>) -> Option<String> {
    let year = caps.get(1)?.as_str().parse::<i32>().ok()?;
    let month = caps.get(2)?.as_str().parse::<u8>().ok()?;
    let day = caps.get(3)?.as_str().parse::<u8>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn contains_any(input: &str, values: &[&str]) -> bool {
    values.iter().any(|value| input.contains(value))
}

fn title_case(input: &str) -> String {
    input
        .split_whitespace()
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn date_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(19\d{2}|20\d{2})[\-/.年](\d{1,2})[\-/.月](\d{1,2})日?").unwrap()
    })
}

fn chinese_region_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"([\p{Han}]{2,16}(?:省|市|自治区|特别行政区))").unwrap())
}

fn english_region_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?:state of |commonwealth of )([a-z][a-z ]{2,24})").unwrap())
}

fn chinese_authority_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"([\p{Han}]{2,24}(?:人民政府|人民法院|人民检察院|委员会|常务委员会|人民代表大会|部))",
        )
        .unwrap()
    })
}

fn english_authority_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"((?:supreme|district|appellate|ministry|department|court) [a-z ]{2,28})")
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_commentary_over_law_when_title_is_explanatory() {
        let metadata = extract_legal_metadata(
            Some("中华人民共和国民法典解读"),
            "commentary/civil-code-guide.md",
            "md",
            "本解读说明民法典中的合同编。",
        );
        assert_eq!(metadata.document_type.as_deref(), Some("commentary"));
        assert_eq!(metadata.jurisdiction.as_deref(), Some("CN-national"));
    }

    #[test]
    fn extracts_superseded_dates_and_authority() {
        let metadata = extract_legal_metadata(
            Some("北京市网络交易管理办法"),
            "bj/regulation.md",
            "md",
            "北京市人民政府发布。自2020年1月1日起施行，2024年12月31日废止。",
        );
        assert_eq!(metadata.document_type.as_deref(), Some("regulation"));
        assert_eq!(metadata.jurisdiction.as_deref(), Some("北京市"));
        assert!(metadata.is_superseded);
        assert_eq!(metadata.effective_date.as_deref(), Some("2020-01-01"));
        assert_eq!(metadata.expiry_date.as_deref(), Some("2024-12-31"));
    }
}
