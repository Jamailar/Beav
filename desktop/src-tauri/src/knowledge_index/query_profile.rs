use serde_json::{json, Value};

use super::hybrid::RetrievalMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegalQueryIntent {
    StatuteLookup,
    CaseSearch,
    ContractClause,
    EvidenceFact,
    CrossFileSynthesis,
    GeneralResearch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CitationRequirement {
    ExactAnchor,
    PreferExactAnchor,
    Flexible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetrievalGranularity {
    CitationSpan,
    SectionBlock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueryLanguage {
    Zh,
    En,
    Mixed,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LegalBiases {
    pub prefer_current_authority: bool,
    pub prefer_primary_sources: bool,
    pub prefer_evidence_artifacts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueryProfile {
    pub normalized_query: String,
    pub intent: LegalQueryIntent,
    pub language: QueryLanguage,
    pub is_bilingual: bool,
    pub citation_requirement: CitationRequirement,
    pub granularity: RetrievalGranularity,
    pub document_type_hints: Vec<&'static str>,
    pub legal_biases: LegalBiases,
    pub recommended_retrieval_mode: RetrievalMode,
    pub rerankers: Vec<&'static str>,
}

pub(crate) fn build_query_profile(query: &str) -> QueryProfile {
    let normalized_query = query.trim().to_string();
    let lowered = normalized_query.to_lowercase();
    let language = detect_language(&normalized_query);
    let is_bilingual = language == QueryLanguage::Mixed;
    let intent = detect_intent(&normalized_query, &lowered);
    let citation_requirement = detect_citation_requirement(&normalized_query, &lowered, intent);
    let granularity = match citation_requirement {
        CitationRequirement::ExactAnchor => RetrievalGranularity::CitationSpan,
        CitationRequirement::PreferExactAnchor => match intent {
            LegalQueryIntent::StatuteLookup
            | LegalQueryIntent::ContractClause
            | LegalQueryIntent::EvidenceFact => RetrievalGranularity::CitationSpan,
            _ => RetrievalGranularity::SectionBlock,
        },
        CitationRequirement::Flexible => RetrievalGranularity::SectionBlock,
    };
    let document_type_hints = document_type_hints(intent);
    let legal_biases = LegalBiases {
        prefer_current_authority: !matches!(intent, LegalQueryIntent::CaseSearch),
        prefer_primary_sources: !matches!(intent, LegalQueryIntent::CrossFileSynthesis),
        prefer_evidence_artifacts: intent == LegalQueryIntent::EvidenceFact,
    };
    let recommended_retrieval_mode = match intent {
        LegalQueryIntent::StatuteLookup | LegalQueryIntent::ContractClause => {
            RetrievalMode::Lexical
        }
        LegalQueryIntent::CaseSearch | LegalQueryIntent::CrossFileSynthesis => {
            RetrievalMode::Hybrid
        }
        LegalQueryIntent::EvidenceFact => {
            if citation_requirement == CitationRequirement::ExactAnchor {
                RetrievalMode::Lexical
            } else {
                RetrievalMode::Hybrid
            }
        }
        LegalQueryIntent::GeneralResearch => {
            if is_bilingual {
                RetrievalMode::Hybrid
            } else {
                RetrievalMode::Lexical
            }
        }
    };

    QueryProfile {
        normalized_query,
        intent,
        language,
        is_bilingual,
        citation_requirement,
        granularity,
        document_type_hints,
        legal_biases,
        recommended_retrieval_mode,
        rerankers: vec!["legal-aware", "citation-aware", "confidence-aware"],
    }
}

pub(crate) fn query_profile_to_json(profile: &QueryProfile) -> Value {
    json!({
        "normalizedQuery": profile.normalized_query,
        "intent": intent_label(profile.intent),
        "language": language_label(profile.language),
        "isBilingual": profile.is_bilingual,
        "citationRequirement": citation_requirement_label(profile.citation_requirement),
        "granularity": granularity_label(profile.granularity),
        "documentTypeHints": profile.document_type_hints,
        "legalBiases": {
            "preferCurrentAuthority": profile.legal_biases.prefer_current_authority,
            "preferPrimarySources": profile.legal_biases.prefer_primary_sources,
            "preferEvidenceArtifacts": profile.legal_biases.prefer_evidence_artifacts
        },
        "recommendedRetrievalMode": retrieval_mode_label(profile.recommended_retrieval_mode),
        "rerankers": profile.rerankers,
    })
}

pub(crate) fn retrieval_mode_label(mode: RetrievalMode) -> &'static str {
    match mode {
        RetrievalMode::Lexical => "lexical",
        RetrievalMode::Hybrid => "hybrid",
    }
}

fn detect_intent(query: &str, lowered: &str) -> LegalQueryIntent {
    if contains_any(
        query,
        &[
            "法条",
            "第",
            "条",
            "法规",
            "条例",
            "民法典",
            "劳动合同法",
            "article",
            "statute",
            "regulation",
            "code",
        ],
    ) && contains_any(
        query,
        &["法", "条", "article", "statute", "regulation", "code"],
    ) {
        return LegalQueryIntent::StatuteLookup;
    }
    if contains_any(
        query,
        &[
            "案例",
            "判决",
            "裁判",
            "法院",
            "案号",
            "case",
            "judgment",
            "opinion",
            "holding",
            "precedent",
        ],
    ) {
        return LegalQueryIntent::CaseSearch;
    }
    if contains_any(
        query,
        &[
            "总结", "归纳", "比较", "对比", "汇总", "summary", "compare", "across", "synth",
            "overview",
        ],
    ) || lowered.contains("multiple documents")
    {
        return LegalQueryIntent::CrossFileSynthesis;
    }
    if contains_any(
        query,
        &[
            "合同",
            "条款",
            "协议",
            "违约责任",
            "终止",
            "clause",
            "contract",
            "agreement",
            "termination",
            "indemnity",
        ],
    ) {
        return LegalQueryIntent::ContractClause;
    }
    if contains_any(
        query,
        &[
            "证据", "邮件", "聊天", "截图", "发票", "附件", "evidence", "email", "invoice",
            "message", "exhibit",
        ],
    ) {
        return LegalQueryIntent::EvidenceFact;
    }
    LegalQueryIntent::GeneralResearch
}

fn detect_citation_requirement(
    query: &str,
    lowered: &str,
    intent: LegalQueryIntent,
) -> CitationRequirement {
    if contains_any(
        query,
        &[
            "引用", "原文", "逐字", "页码", "第", "条", "\"", "“", "”", "cite", "exact", "quote",
            "verbatim", "page", "section", "clause", "article",
        ],
    ) {
        return CitationRequirement::ExactAnchor;
    }
    match intent {
        LegalQueryIntent::StatuteLookup
        | LegalQueryIntent::ContractClause
        | LegalQueryIntent::EvidenceFact => CitationRequirement::PreferExactAnchor,
        LegalQueryIntent::CaseSearch | LegalQueryIntent::CrossFileSynthesis => {
            if lowered.contains("quote") || lowered.contains("citation") {
                CitationRequirement::ExactAnchor
            } else {
                CitationRequirement::Flexible
            }
        }
        LegalQueryIntent::GeneralResearch => CitationRequirement::Flexible,
    }
}

fn document_type_hints(intent: LegalQueryIntent) -> Vec<&'static str> {
    match intent {
        LegalQueryIntent::StatuteLookup => vec!["statute", "regulation"],
        LegalQueryIntent::CaseSearch => vec!["case", "judgment"],
        LegalQueryIntent::ContractClause => vec!["contract", "policy"],
        LegalQueryIntent::EvidenceFact => vec!["evidence", "email", "attachment"],
        LegalQueryIntent::CrossFileSynthesis => vec!["statute", "case", "commentary"],
        LegalQueryIntent::GeneralResearch => vec!["statute", "case", "contract", "commentary"],
    }
}

fn detect_language(query: &str) -> QueryLanguage {
    let has_cjk = query.chars().any(is_cjk);
    let has_ascii_alpha = query.chars().any(|ch| ch.is_ascii_alphabetic());
    match (has_cjk, has_ascii_alpha) {
        (true, true) => QueryLanguage::Mixed,
        (true, false) => QueryLanguage::Zh,
        (false, true) => QueryLanguage::En,
        _ => QueryLanguage::Other,
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF)
}

fn contains_any(query: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| query.contains(needle))
}

fn intent_label(intent: LegalQueryIntent) -> &'static str {
    match intent {
        LegalQueryIntent::StatuteLookup => "statute_lookup",
        LegalQueryIntent::CaseSearch => "case_search",
        LegalQueryIntent::ContractClause => "contract_clause",
        LegalQueryIntent::EvidenceFact => "evidence_fact",
        LegalQueryIntent::CrossFileSynthesis => "cross_file_synthesis",
        LegalQueryIntent::GeneralResearch => "general_research",
    }
}

fn citation_requirement_label(value: CitationRequirement) -> &'static str {
    match value {
        CitationRequirement::ExactAnchor => "exact_anchor",
        CitationRequirement::PreferExactAnchor => "prefer_exact_anchor",
        CitationRequirement::Flexible => "flexible",
    }
}

fn granularity_label(value: RetrievalGranularity) -> &'static str {
    match value {
        RetrievalGranularity::CitationSpan => "citation_span",
        RetrievalGranularity::SectionBlock => "section_block",
    }
}

fn language_label(value: QueryLanguage) -> &'static str {
    match value {
        QueryLanguage::Zh => "zh",
        QueryLanguage::En => "en",
        QueryLanguage::Mixed => "mixed",
        QueryLanguage::Other => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_statute_lookup_as_exact_lexical() {
        let profile = build_query_profile("请引用民法典第577条原文");
        assert_eq!(profile.intent, LegalQueryIntent::StatuteLookup);
        assert_eq!(
            profile.citation_requirement,
            CitationRequirement::ExactAnchor
        );
        assert_eq!(profile.granularity, RetrievalGranularity::CitationSpan);
        assert_eq!(profile.recommended_retrieval_mode, RetrievalMode::Lexical);
    }

    #[test]
    fn classifies_bilingual_case_search_as_hybrid() {
        let profile = build_query_profile("find employment termination case 判决 reasoning");
        assert_eq!(profile.intent, LegalQueryIntent::CaseSearch);
        assert_eq!(profile.language, QueryLanguage::Mixed);
        assert!(profile.is_bilingual);
        assert_eq!(profile.recommended_retrieval_mode, RetrievalMode::Hybrid);
    }

    #[test]
    fn classifies_evidence_query_with_quote_as_exact() {
        let profile = build_query_profile("引用邮件原文证明付款承诺");
        assert_eq!(profile.intent, LegalQueryIntent::EvidenceFact);
        assert_eq!(
            profile.citation_requirement,
            CitationRequirement::ExactAnchor
        );
        assert!(profile.legal_biases.prefer_evidence_artifacts);
    }
}
