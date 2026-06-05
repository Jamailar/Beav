use super::*;

fn role_profile_defaults(role_id: &str) -> Value {
    let role_spec = runtime_subagent_role_spec(role_id);
    let normalized_role = role_id.trim().to_ascii_lowercase();
    let (specialties, good_at, preferred_tasks, avoid_tasks, allowed_families) =
        match normalized_role.as_str() {
            "planner" => (
                vec!["task_planning", "dependency_mapping", "execution_design"],
                vec!["拆解目标", "定义阶段", "发现依赖", "生成可派发任务"],
                vec!["planning", "coordination", "task_decomposition"],
                vec!["final_review", "long_form_copy"],
                vec!["team.task", "team.member", "knowledge.search"],
            ),
            "researcher" => (
                vec!["research", "source_synthesis", "knowledge_retrieval"],
                vec!["检索证据", "整理来源", "标注不确定项", "形成研究摘要"],
                vec!["research", "evidence_collection", "knowledge_lookup"],
                vec!["visual_generation", "final_delivery_claim"],
                vec!["resource", "knowledge.search", "web.fetch"],
            ),
            "copywriter" => (
                vec!["writing", "editing", "publishing_copy"],
                vec!["正文成稿", "标题包装", "发布话术", "内容润色"],
                vec!["copywriting", "manuscript_creation", "content_polish"],
                vec!["source_verification", "media_rendering"],
                vec!["manuscripts", "resource", "editor"],
            ),
            "image-director" => (
                vec!["image_generation", "cover_direction", "visual_prompting"],
                vec!["视觉方案", "图片提示词", "封面构图", "出图验收"],
                vec!["image_generation", "cover_design", "visual_direction"],
                vec!["backend_debugging", "long_code_review"],
                vec!["media.generate", "image.generate", "resource"],
            ),
            "video-director" => (
                vec!["shot_design", "video_generation", "edit_planning"],
                vec!["镜头规划", "剪辑结构", "时间线表达", "可执行视觉规范"],
                vec!["video_generation", "timeline_planning"],
                vec!["legal_review", "billing_debugging"],
                vec!["editor", "media.generate", "resource"],
            ),
            "reviewer" => (
                vec!["quality_review", "verification", "risk_detection"],
                vec!["验收结果", "发现缺口", "阻止伪成功", "生成修复建议"],
                vec!["review", "verification", "acceptance_check"],
                vec!["primary_authoring", "self_review"],
                vec!["resource", "team.task", "knowledge.search"],
            ),
            _ => (
                vec!["operations", "maintenance", "runtime_coordination"],
                vec!["后台推进", "状态检查", "恢复任务", "维护运行链路"],
                vec!["ops", "maintenance", "runtime_recovery"],
                vec!["brand_copy", "visual_concept"],
                vec!["workflow", "resource", "runtime"],
            ),
        };

    json!({
        "version": 1,
        "memberId": "",
        "displayName": "",
        "roleId": normalized_role,
        "oneLine": role_spec.purpose,
        "persona": role_spec.system_prompt,
        "specialties": specialties,
        "goodAt": good_at,
        "notGoodAt": [],
        "preferredTasks": preferred_tasks,
        "avoidTasks": avoid_tasks,
        "toolPolicy": {
            "allowedFamilies": allowed_families,
            "allowedTools": [],
            "requiresConfirmation": []
        },
        "capacity": {
            "maxExecutorThreads": 5,
            "defaultExecutorThreads": 1
        },
        "decisionBoundary": role_spec.handoff_contract,
        "outputSchema": role_spec.output_schema
    })
}

pub(super) fn build_member_agent_card(
    member_id: &str,
    display_name: &str,
    role_id: &str,
    capabilities: &[String],
    allowed_tools: &[String],
    payload: &Value,
    metadata: Option<&Value>,
) -> Value {
    let overlay = metadata.and_then(|value| value.get("agentCard").cloned());
    let mut card = merge_object_defaults(role_profile_defaults(role_id), overlay);
    let Some(object) = card.as_object_mut() else {
        return card;
    };

    object.insert("memberId".to_string(), json!(member_id));
    object.insert("displayName".to_string(), json!(display_name));
    object.insert("roleId".to_string(), json!(role_id));
    if !capabilities.is_empty() {
        object.insert("capabilities".to_string(), json!(capabilities));
    }
    if !allowed_tools.is_empty() {
        let policy = object
            .entry("toolPolicy".to_string())
            .or_insert_with(|| json!({}));
        if let Some(policy_object) = policy.as_object_mut() {
            policy_object.insert("allowedTools".to_string(), json!(allowed_tools));
        }
    }

    for key in ["oneLine", "persona", "decisionBoundary", "outputSchema"] {
        if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
            object.insert(key.to_string(), value.clone());
        }
    }
    for (key, fallback) in [
        ("specialties", &[] as &[&str]),
        ("goodAt", &[] as &[&str]),
        ("notGoodAt", &[] as &[&str]),
        ("preferredTasks", &[] as &[&str]),
        ("avoidTasks", &[] as &[&str]),
    ] {
        let values = value_string_array_or_default(payload, key, fallback);
        if !values.is_empty() {
            object.insert(key.to_string(), Value::Array(values));
        }
    }
    card
}

pub(super) fn member_metadata_from_payload(
    member_id: &str,
    session_id: &str,
    display_name: &str,
    role_id: &str,
    capabilities: &[String],
    allowed_tools: &[String],
    payload: &Value,
) -> Option<Value> {
    let mut metadata = value_object(payload, "metadata")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for key in [
        "advisorId",
        "sourceId",
        "knowledgeSourceId",
        "rootPath",
        "knowledgeRootPath",
    ] {
        if let Some(value) = payload.get(key).filter(|value| !value.is_null()) {
            metadata.insert(key.to_string(), value.clone());
        }
    }
    let metadata_value = Value::Object(metadata.clone());
    let agent_card = build_member_agent_card(
        member_id,
        display_name,
        role_id,
        capabilities,
        allowed_tools,
        payload,
        Some(&metadata_value),
    );
    metadata.insert("agentCard".to_string(), agent_card);
    let plan_overlay = metadata.get("memberTaskPlan");
    metadata.insert(
        "memberTaskPlan".to_string(),
        initial_member_task_plan(member_id, session_id, plan_overlay),
    );
    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}
