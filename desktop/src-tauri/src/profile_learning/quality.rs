use super::DistillationModel;

pub(crate) fn quality_warnings(model: &DistillationModel) -> Vec<String> {
    let mut warnings = Vec::new();
    if model.post_count < 10 {
        warnings.push("样本少于 10 条，只能形成初步风格判断。".to_string());
    }
    if model.post_count > 0 && model.content_complete_count * 2 < model.post_count {
        warnings.push("正文完整率低于 50%，认知层与正文结构判断不稳定。".to_string());
    }
    if model.opinion_candidates.len() < 3 {
        warnings.push("观点句候选不足，核心信念暂不应强写入长期记忆。".to_string());
    }
    warnings
}

pub(crate) fn quality_ready_for_runtime(model: &DistillationModel) -> bool {
    model.post_count >= 3 && model.content_complete_count > 0 && model.quality_warnings.len() <= 2
}
