use crate::{AppStore, parse_timestamp_ms};
use chrono::{Datelike, Duration, Local, LocalResult, NaiveTime, TimeZone, Timelike, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_PENDING_PER_CONVERSATION: usize = 2;
const MIN_INTERVAL_MINUTES: i64 = 5;
const MAX_CONSECUTIVE_FAILURES_BEFORE_COOLDOWN: usize = 3;
const TASK_CONTRACT_VERSION: &str = "task-contract/v1";
const HIGH_RISK_ACTION_TYPES: &[&str] = &[
    "delete",
    "external_send",
    "media_publish",
    "publish",
    "write_file",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskIntentSchema {
    pub kind: String,
    pub intent: String,
    pub name: String,
    pub cron: Option<String>,
    pub goal: Option<String>,
    pub action_type: String,
    pub owner_scope: String,
    pub window: Option<String>,
    pub timezone: Option<String>,
    pub creator_mode: Option<String>,
    pub created_by: Option<String>,
    pub risk_rationale: Option<String>,
    pub prompt: Option<String>,
    pub objective: Option<String>,
    pub step_prompt: Option<String>,
    pub mode: Option<String>,
    pub interval_minutes: Option<i64>,
    pub time: Option<String>,
    pub weekdays: Option<Vec<i64>>,
    pub run_at: Option<String>,
    pub total_rounds: Option<i64>,
    pub missed_run_policy: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPolicyDecisionKind {
    Allow,
    RequireConfirm,
    Reject,
}

impl Default for TaskPolicyDecisionKind {
    fn default() -> Self {
        Self::Allow
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskConflictSummary {
    pub definition_id: String,
    pub title: String,
    pub owner_scope: Option<String>,
    pub action_type: Option<String>,
    pub trigger_kind: String,
    pub next_due_at: Option<String>,
    pub requires_confirmation: bool,
    pub lifecycle_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct NormalizedTaskSpec {
    pub kind: String,
    pub mode: String,
    pub interval_minutes: Option<i64>,
    pub time: Option<String>,
    pub weekdays: Option<Vec<i64>>,
    pub run_at: Option<String>,
    pub next_due_at: String,
    pub preview_label: String,
    pub frequency_minutes: Option<i64>,
    pub progression_kind: String,
    pub total_rounds: Option<i64>,
    pub missed_run_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TaskPreviewResult {
    pub decision: String,
    pub policy_decision: TaskPolicyDecisionKind,
    pub preview_token: String,
    pub preview_run_at: String,
    pub policy_warnings: Vec<String>,
    pub rejection_reasons: Vec<String>,
    pub conflict_tasks: Vec<TaskConflictSummary>,
    pub requires_confirmation: bool,
    pub definition_fingerprint: String,
    pub policy_signature: String,
    pub normalized: NormalizedTaskSpec,
}

#[derive(Debug, Clone, Copy)]
enum ScheduleKind {
    Interval(i64),
    Daily {
        hour: u32,
        minute: u32,
    },
    Weekly {
        hour: u32,
        minute: u32,
        weekdays: [bool; 7],
    },
    Once(i64),
}

pub fn fingerprint_for_definition_payload(
    kind: &str,
    title: &str,
    owner_scope: &str,
    trigger_kind: &str,
    payload: &Value,
) -> String {
    let normalized = json!({
        "kind": kind.trim().to_lowercase(),
        "title": title.trim(),
        "ownerScope": owner_scope.trim().to_lowercase(),
        "triggerKind": trigger_kind.trim().to_lowercase(),
        "payload": payload,
    });
    hash_text(&normalized.to_string())
}

pub fn preview_task_intent(
    store: &AppStore,
    intent: &TaskIntentSchema,
    now_ms: i64,
) -> Result<TaskPreviewResult, String> {
    let normalized = normalize_task_intent(intent, now_ms)?;
    let definition_fingerprint = fingerprint_for_definition_payload(
        &normalized.kind,
        &intent.name,
        intent.owner_scope.as_str(),
        &normalized.mode,
        &json!({
            "actionType": intent.action_type,
            "goal": intent.goal,
            "prompt": intent.prompt,
            "objective": intent.objective,
            "stepPrompt": intent.step_prompt,
            "intervalMinutes": normalized.interval_minutes,
            "time": normalized.time,
            "weekdays": normalized.weekdays,
            "runAt": normalized.run_at,
            "totalRounds": normalized.total_rounds,
        }),
    );

    let mut warnings = Vec::new();
    let mut rejection_reasons = Vec::new();
    let mut conflicts = collect_conflicts(store, intent, &definition_fingerprint);
    let pending_drafts = store
        .redclaw_job_definitions
        .iter()
        .filter(|item| {
            item.owner_scope.as_deref() == Some(intent.owner_scope.as_str())
                && item.requires_confirmation
        })
        .count();

    if pending_drafts >= MAX_PENDING_PER_CONVERSATION {
        rejection_reasons.push(format!(
            "当前 ownerScope 已存在 {} 个待确认任务，超过会话阈值 {}。",
            pending_drafts, MAX_PENDING_PER_CONVERSATION
        ));
    }

    if let Some(frequency) = normalized.frequency_minutes {
        if frequency < MIN_INTERVAL_MINUTES && !is_admin_creator(intent.creator_mode.as_deref()) {
            rejection_reasons.push(format!(
                "任务频率 {} 分钟低于最小阈值 {} 分钟。",
                frequency, MIN_INTERVAL_MINUTES
            ));
        }
    }

    if is_high_risk_action(intent.action_type.as_str()) {
        warnings.push("高风险动作需要显式确认，并建议附带 riskRationale。".to_string());
        if intent
            .risk_rationale
            .as_deref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            rejection_reasons.push("高风险任务必须附带 riskRationale。".to_string());
        }
    }

    if let Some(cooldown_reason) =
        active_cooldown_reason(store, intent.owner_scope.as_str(), &definition_fingerprint)
    {
        rejection_reasons.push(format!(
            "该任务指纹处于 cooldown，需人工确认后恢复。{cooldown_reason}"
        ));
    }

    let exact_duplicate_exists = conflicts
        .iter()
        .any(|item| item.lifecycle_state == "active");
    if exact_duplicate_exists {
        rejection_reasons.push("检测到同 ownerScope + 同定义指纹的重复任务。".to_string());
    } else if !conflicts.is_empty() {
        warnings.push("检测到同 ownerScope 下的相似任务，建议确认后再创建。".to_string());
    }

    let policy_decision = if !rejection_reasons.is_empty() {
        TaskPolicyDecisionKind::Reject
    } else if is_high_risk_action(intent.action_type.as_str()) || !conflicts.is_empty() {
        TaskPolicyDecisionKind::RequireConfirm
    } else {
        TaskPolicyDecisionKind::Allow
    };
    let requires_confirmation = !matches!(policy_decision, TaskPolicyDecisionKind::Allow);

    let decision = match policy_decision {
        TaskPolicyDecisionKind::Allow => "ok",
        TaskPolicyDecisionKind::RequireConfirm => {
            if conflicts.is_empty() {
                "ok"
            } else {
                "conflict"
            }
        }
        TaskPolicyDecisionKind::Reject => {
            if conflicts.is_empty() {
                "reject"
            } else {
                "conflict"
            }
        }
    };

    let preview_payload = json!({
        "fingerprint": definition_fingerprint,
        "decision": decision,
        "policyDecision": policy_decision,
        "previewRunAt": normalized.next_due_at,
        "warnings": warnings,
        "reasons": rejection_reasons,
        "requiresConfirmation": !matches!(policy_decision, TaskPolicyDecisionKind::Allow),
        "normalized": normalized,
        "ownerScope": intent.owner_scope,
    });
    let policy_signature = hash_text(&preview_payload.to_string());
    let preview_token = hash_text(&format!(
        "{}:{}:{}",
        definition_fingerprint, normalized.next_due_at, policy_signature
    ));

    conflicts.sort_by(|left, right| right.next_due_at.cmp(&left.next_due_at));

    Ok(TaskPreviewResult {
        decision: decision.to_string(),
        policy_decision,
        preview_token,
        preview_run_at: normalized.next_due_at.clone(),
        policy_warnings: warnings,
        rejection_reasons,
        conflict_tasks: conflicts,
        requires_confirmation,
        definition_fingerprint,
        policy_signature,
        normalized,
    })
}

fn collect_conflicts(
    store: &AppStore,
    intent: &TaskIntentSchema,
    fingerprint: &str,
) -> Vec<TaskConflictSummary> {
    store
        .redclaw_job_definitions
        .iter()
        .filter_map(|item| {
            let item_owner_scope = item
                .owner_scope
                .clone()
                .or_else(|| item.owner_context_id.clone())
                .unwrap_or_else(|| "legacy:redclaw".to_string());
            if item_owner_scope != intent.owner_scope {
                return None;
            }
            let item_action_type = item
                .payload
                .get("actionType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let item_fingerprint = item.definition_fingerprint.clone().unwrap_or_else(|| {
                fingerprint_for_definition_payload(
                    &item.kind,
                    &item.title,
                    item_owner_scope.as_str(),
                    &item.trigger_kind,
                    &item.payload,
                )
            });
            if item_fingerprint != fingerprint && item_action_type != intent.action_type {
                return None;
            }
            let lifecycle_state = if item.requires_confirmation {
                "draft"
            } else if item.enabled {
                "active"
            } else {
                "paused"
            };
            Some(TaskConflictSummary {
                definition_id: item.id.clone(),
                title: item.title.clone(),
                owner_scope: item.owner_scope.clone(),
                action_type: Some(item_action_type),
                trigger_kind: item.trigger_kind.clone(),
                next_due_at: item.next_due_at.clone(),
                requires_confirmation: item.requires_confirmation,
                lifecycle_state: lifecycle_state.to_string(),
            })
        })
        .collect()
}

fn normalize_task_intent(
    intent: &TaskIntentSchema,
    now_ms: i64,
) -> Result<NormalizedTaskSpec, String> {
    let kind = normalized_kind(intent.kind.as_str(), intent.action_type.as_str());
    let schedule = parse_schedule(intent, now_ms, kind == "long_cycle")?;
    let next_due_at = compute_next_due_at(schedule, now_ms, intent.timezone.as_deref())?;
    Ok(match schedule {
        ScheduleKind::Interval(minutes) => NormalizedTaskSpec {
            kind: kind.to_string(),
            mode: "interval".to_string(),
            interval_minutes: Some(minutes),
            time: None,
            weekdays: None,
            run_at: None,
            next_due_at: next_due_at.to_string(),
            preview_label: format!("每 {} 分钟", minutes),
            frequency_minutes: Some(minutes),
            progression_kind: if kind == "long_cycle" {
                "multi_round".to_string()
            } else {
                "single_run".to_string()
            },
            total_rounds: if kind == "long_cycle" {
                Some(intent.total_rounds.unwrap_or(12).max(1))
            } else {
                None
            },
            missed_run_policy: normalize_missed_run_policy(intent.missed_run_policy.as_deref()),
        },
        ScheduleKind::Daily { hour, minute } => NormalizedTaskSpec {
            kind: kind.to_string(),
            mode: "daily".to_string(),
            interval_minutes: None,
            time: Some(format!("{hour:02}:{minute:02}")),
            weekdays: None,
            run_at: None,
            next_due_at: next_due_at.to_string(),
            preview_label: format!("每天 {:02}:{:02}", hour, minute),
            frequency_minutes: Some(24 * 60),
            progression_kind: "single_run".to_string(),
            total_rounds: None,
            missed_run_policy: normalize_missed_run_policy(intent.missed_run_policy.as_deref()),
        },
        ScheduleKind::Weekly {
            hour,
            minute,
            weekdays,
        } => {
            let weekday_values = weekdays
                .iter()
                .enumerate()
                .filter_map(|(index, enabled)| enabled.then_some(index as i64))
                .collect::<Vec<_>>();
            NormalizedTaskSpec {
                kind: kind.to_string(),
                mode: "weekly".to_string(),
                interval_minutes: None,
                time: Some(format!("{hour:02}:{minute:02}")),
                weekdays: Some(weekday_values.clone()),
                run_at: None,
                next_due_at: next_due_at.to_string(),
                preview_label: format!("每周 {:?} {:02}:{:02}", weekday_values, hour, minute),
                frequency_minutes: Some(7 * 24 * 60),
                progression_kind: "single_run".to_string(),
                total_rounds: None,
                missed_run_policy: normalize_missed_run_policy(intent.missed_run_policy.as_deref()),
            }
        }
        ScheduleKind::Once(run_at) => NormalizedTaskSpec {
            kind: kind.to_string(),
            mode: "once".to_string(),
            interval_minutes: None,
            time: None,
            weekdays: None,
            run_at: Some(run_at.to_string()),
            next_due_at: next_due_at.to_string(),
            preview_label: "单次执行".to_string(),
            frequency_minutes: None,
            progression_kind: "single_run".to_string(),
            total_rounds: None,
            missed_run_policy: normalize_missed_run_policy(intent.missed_run_policy.as_deref()),
        },
    })
}

fn normalized_kind(kind: &str, action_type: &str) -> &'static str {
    let normalized = kind.trim().to_lowercase();
    if normalized == "long_cycle" || action_type.trim().eq_ignore_ascii_case("long_cycle") {
        "long_cycle"
    } else {
        "scheduled"
    }
}

fn parse_schedule(
    intent: &TaskIntentSchema,
    now_ms: i64,
    is_long_cycle: bool,
) -> Result<ScheduleKind, String> {
    if let Some(cron) = intent.cron.as_deref() {
        return parse_cron_like_schedule(cron, now_ms, is_long_cycle);
    }

    if let Some(run_at) = intent.run_at.as_deref() {
        let run_at_ms = parse_timestamp_ms(run_at)
            .ok_or_else(|| "runAt 不是有效的时间戳或 RFC3339 时间".to_string())?;
        return Ok(ScheduleKind::Once(run_at_ms));
    }

    let mode = intent
        .mode
        .clone()
        .unwrap_or_else(|| {
            if is_long_cycle {
                "interval".to_string()
            } else {
                "daily".to_string()
            }
        })
        .trim()
        .to_lowercase();

    match mode.as_str() {
        "interval" => Ok(ScheduleKind::Interval(
            intent
                .interval_minutes
                .unwrap_or(if is_long_cycle { 720 } else { 60 }),
        )),
        "daily" => {
            let (hour, minute) = parse_clock_time(intent.time.as_deref().unwrap_or("09:00"))?;
            Ok(ScheduleKind::Daily { hour, minute })
        }
        "weekly" => {
            let (hour, minute) = parse_clock_time(intent.time.as_deref().unwrap_or("09:00"))?;
            let weekdays = parse_weekday_list(intent.weekdays.as_deref().unwrap_or(&[1]));
            Ok(ScheduleKind::Weekly {
                hour,
                minute,
                weekdays,
            })
        }
        "once" => {
            let run_at_ms = intent
                .run_at
                .as_deref()
                .and_then(parse_timestamp_ms)
                .ok_or_else(|| "一次性任务需要 runAt".to_string())?;
            Ok(ScheduleKind::Once(run_at_ms))
        }
        other => Err(format!("不支持的调度模式: {other}")),
    }
}

fn parse_cron_like_schedule(
    cron: &str,
    now_ms: i64,
    is_long_cycle: bool,
) -> Result<ScheduleKind, String> {
    let trimmed = cron.trim();
    if let Some(value) = trimmed.strip_prefix("@every ") {
        let minutes = parse_duration_to_minutes(value)?;
        return Ok(ScheduleKind::Interval(minutes));
    }
    if let Some(value) = trimmed.strip_prefix("@once ") {
        let run_at_ms = parse_timestamp_ms(value.trim())
            .ok_or_else(|| "@once 需要 RFC3339 或毫秒时间戳".to_string())?;
        return Ok(ScheduleKind::Once(run_at_ms));
    }

    let fields = trimmed.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err("cron 仅支持标准 5 段表达式，或 @every / @once 扩展语法".to_string());
    }
    let minute_field = fields[0];
    let hour_field = fields[1];
    let day_of_month = fields[2];
    let month = fields[3];
    let day_of_week = fields[4];
    if day_of_month != "*" || month != "*" {
        return Err("当前仅支持 */N * * * *、M H * * *、M H * * D 这三类 cron".to_string());
    }
    if let Some(interval) = minute_field.strip_prefix("*/") {
        if hour_field == "*" && day_of_week == "*" {
            return Ok(ScheduleKind::Interval(
                interval
                    .parse::<i64>()
                    .map_err(|_| "cron interval 需要是数字分钟".to_string())?,
            ));
        }
    }

    let minute = minute_field
        .parse::<u32>()
        .map_err(|_| "cron 的分钟必须是 0-59 整数".to_string())?;
    let hour = hour_field
        .parse::<u32>()
        .map_err(|_| "cron 的小时必须是 0-23 整数".to_string())?;
    if is_long_cycle {
        let next_due_at = compute_next_due_at(ScheduleKind::Daily { hour, minute }, now_ms, None)?;
        let frequency_minutes = ((next_due_at - now_ms) / 60_000).max(MIN_INTERVAL_MINUTES);
        return Ok(ScheduleKind::Interval(frequency_minutes));
    }
    if day_of_week == "*" {
        return Ok(ScheduleKind::Daily { hour, minute });
    }
    Ok(ScheduleKind::Weekly {
        hour,
        minute,
        weekdays: parse_weekday_tokens(day_of_week)?,
    })
}

fn compute_next_due_at(
    schedule: ScheduleKind,
    now_ms: i64,
    timezone: Option<&str>,
) -> Result<i64, String> {
    match schedule {
        ScheduleKind::Interval(minutes) => Ok(now_ms + minutes.max(1) * 60_000),
        ScheduleKind::Daily { hour, minute } => {
            next_daily_timestamp_in_timezone(hour, minute, now_ms, timezone)
        }
        ScheduleKind::Weekly {
            hour,
            minute,
            weekdays,
        } => next_weekly_timestamp_in_timezone(hour, minute, weekdays, now_ms, timezone),
        ScheduleKind::Once(run_at_ms) => Ok(run_at_ms),
    }
}

fn localize(naive: chrono::NaiveDateTime) -> Result<chrono::DateTime<Local>, String> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value),
        LocalResult::Ambiguous(earliest, _) => Ok(earliest),
        LocalResult::None => Err("当前本地时区无法解析调度时间".to_string()),
    }
}

pub fn next_daily_timestamp_in_timezone(
    hour: u32,
    minute: u32,
    now_ms: i64,
    timezone: Option<&str>,
) -> Result<i64, String> {
    match parse_timezone(timezone)? {
        ScheduleTimezone::Local => {
            let now = Local
                .timestamp_millis_opt(now_ms)
                .single()
                .ok_or_else(|| "无法解析当前本地时间".to_string())?;
            let today = now.date_naive();
            let candidate = today
                .and_hms_opt(hour, minute, 0)
                .ok_or_else(|| "daily 时间字段无效".to_string())?;
            let candidate = localize(candidate)?;
            if candidate.timestamp_millis() > now_ms {
                return Ok(candidate.timestamp_millis());
            }
            let tomorrow = today
                .succ_opt()
                .ok_or_else(|| "无法计算下一日调度".to_string())?;
            Ok(localize(
                tomorrow
                    .and_hms_opt(hour, minute, 0)
                    .ok_or_else(|| "daily 时间字段无效".to_string())?,
            )?
            .timestamp_millis())
        }
        ScheduleTimezone::Named(tz) => {
            let now = tz
                .timestamp_millis_opt(now_ms)
                .single()
                .ok_or_else(|| "无法解析目标时区时间".to_string())?;
            let today = now.date_naive();
            let candidate = localize_named(tz, today, hour, minute)?;
            if candidate > now_ms {
                return Ok(candidate);
            }
            let tomorrow = today
                .succ_opt()
                .ok_or_else(|| "无法计算下一日调度".to_string())?;
            localize_named(tz, tomorrow, hour, minute)
        }
    }
}

pub fn next_weekly_timestamp_in_timezone(
    hour: u32,
    minute: u32,
    weekdays: [bool; 7],
    now_ms: i64,
    timezone: Option<&str>,
) -> Result<i64, String> {
    match parse_timezone(timezone)? {
        ScheduleTimezone::Local => {
            let now = Local
                .timestamp_millis_opt(now_ms)
                .single()
                .ok_or_else(|| "无法解析当前本地时间".to_string())?;
            for offset in 0..8 {
                let date = now
                    .date_naive()
                    .checked_add_signed(Duration::days(offset))
                    .ok_or_else(|| "无法计算 weekly 调度".to_string())?;
                if !weekdays[weekday_index(date.weekday())] {
                    continue;
                }
                let candidate = localize(
                    date.and_hms_opt(hour, minute, 0)
                        .ok_or_else(|| "weekly 时间字段无效".to_string())?,
                )?;
                if candidate.timestamp_millis() > now_ms {
                    return Ok(candidate.timestamp_millis());
                }
            }
            Err("无法计算下一次 weekly 触发时间".to_string())
        }
        ScheduleTimezone::Named(tz) => {
            let now = tz
                .timestamp_millis_opt(now_ms)
                .single()
                .ok_or_else(|| "无法解析目标时区时间".to_string())?;
            for offset in 0..8 {
                let date = now
                    .date_naive()
                    .checked_add_signed(Duration::days(offset))
                    .ok_or_else(|| "无法计算 weekly 调度".to_string())?;
                if !weekdays[weekday_index(date.weekday())] {
                    continue;
                }
                let candidate = localize_named(tz, date, hour, minute)?;
                if candidate > now_ms {
                    return Ok(candidate);
                }
            }
            Err("无法计算下一次 weekly 触发时间".to_string())
        }
    }
}

enum ScheduleTimezone {
    Local,
    Named(Tz),
}

fn parse_timezone(timezone: Option<&str>) -> Result<ScheduleTimezone, String> {
    let Some(raw) = timezone.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(ScheduleTimezone::Local);
    };
    if raw.eq_ignore_ascii_case("local") {
        return Ok(ScheduleTimezone::Local);
    }
    raw.parse::<Tz>()
        .map(ScheduleTimezone::Named)
        .map_err(|_| format!("无法识别时区: {raw}"))
}

fn localize_named(tz: Tz, date: chrono::NaiveDate, hour: u32, minute: u32) -> Result<i64, String> {
    let naive = date
        .and_hms_opt(hour, minute, 0)
        .ok_or_else(|| "时区调度时间无效".to_string())?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value.timestamp_millis()),
        LocalResult::Ambiguous(earliest, _) => Ok(earliest.timestamp_millis()),
        LocalResult::None => Err("当前时区无法解析调度时间".to_string()),
    }
}

fn parse_duration_to_minutes(value: &str) -> Result<i64, String> {
    let trimmed = value.trim().to_lowercase();
    if let Some(minutes) = trimmed.strip_suffix('m') {
        return minutes
            .parse::<i64>()
            .map_err(|_| "分钟间隔不是有效数字".to_string());
    }
    if let Some(hours) = trimmed.strip_suffix('h') {
        return hours
            .parse::<i64>()
            .map(|value| value * 60)
            .map_err(|_| "小时间隔不是有效数字".to_string());
    }
    if let Some(days) = trimmed.strip_suffix('d') {
        return days
            .parse::<i64>()
            .map(|value| value * 24 * 60)
            .map_err(|_| "天间隔不是有效数字".to_string());
    }
    trimmed
        .parse::<i64>()
        .map_err(|_| "interval 仅支持纯分钟数字或 Xm/Xh/Xd".to_string())
}

fn parse_clock_time(value: &str) -> Result<(u32, u32), String> {
    let parsed = NaiveTime::parse_from_str(value.trim(), "%H:%M")
        .map_err(|_| "time 需要 HH:MM 格式".to_string())?;
    Ok((parsed.hour(), parsed.minute()))
}

fn parse_weekday_list(values: &[i64]) -> [bool; 7] {
    let mut weekdays = [false; 7];
    for value in values {
        let index = ((*value).rem_euclid(7)) as usize;
        weekdays[index] = true;
    }
    weekdays
}

fn parse_weekday_tokens(value: &str) -> Result<[bool; 7], String> {
    let mut weekdays = [false; 7];
    for token in value.split(',') {
        let index = parse_weekday_token(token.trim())?;
        weekdays[index] = true;
    }
    Ok(weekdays)
}

fn parse_weekday_token(token: &str) -> Result<usize, String> {
    match token.trim().to_lowercase().as_str() {
        "0" | "7" | "sun" => Ok(0),
        "1" | "mon" => Ok(1),
        "2" | "tue" => Ok(2),
        "3" | "wed" => Ok(3),
        "4" | "thu" => Ok(4),
        "5" | "fri" => Ok(5),
        "6" | "sat" => Ok(6),
        other => Err(format!("无法识别的 weekday: {other}")),
    }
}

fn weekday_index(weekday: Weekday) -> usize {
    match weekday {
        Weekday::Sun => 0,
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
    }
}

fn is_high_risk_action(action_type: &str) -> bool {
    HIGH_RISK_ACTION_TYPES
        .iter()
        .any(|item| action_type.trim().eq_ignore_ascii_case(item))
}

fn normalize_missed_run_policy(value: Option<&str>) -> String {
    match value.unwrap_or("single").trim().to_lowercase().as_str() {
        "drop" => "drop".to_string(),
        "catchup" => "catchup".to_string(),
        _ => "single".to_string(),
    }
}

fn is_admin_creator(creator_mode: Option<&str>) -> bool {
    creator_mode
        .map(|value| value.trim().eq_ignore_ascii_case("admin"))
        .unwrap_or(false)
}

fn active_cooldown_reason(
    store: &AppStore,
    owner_scope: &str,
    fingerprint: &str,
) -> Option<String> {
    let cooldown = store
        .redclaw_job_definitions
        .iter()
        .find(|item| {
            item.owner_scope.as_deref() == Some(owner_scope)
                && item.definition_fingerprint.as_deref() == Some(fingerprint)
        })
        .and_then(|definition| definition.payload.get("cooldown"))
        .cloned()?;
    if cooldown
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "active"
    {
        return None;
    }
    let consecutive = cooldown
        .get("consecutiveFailures")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_CONSECUTIVE_FAILURES_BEFORE_COOLDOWN as u64);
    let reason = cooldown
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("连续失败进入冷却");
    Some(format!("连续失败 {consecutive} 次，原因：{reason}"))
}

fn hash_text(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn task_contract_version() -> &'static str {
    TASK_CONTRACT_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_interval_preview_normalizes_every_fifteen_minutes() {
        let preview = normalize_task_intent(
            &TaskIntentSchema {
                name: "test".to_string(),
                owner_scope: "conversation:a".to_string(),
                action_type: "redclaw_prompt".to_string(),
                cron: Some("*/15 * * * *".to_string()),
                ..TaskIntentSchema::default()
            },
            1_700_000_000_000,
        )
        .expect("normalize");
        assert_eq!(preview.mode, "interval");
        assert_eq!(preview.interval_minutes, Some(15));
    }

    #[test]
    fn daily_preview_uses_local_clock_format() {
        let preview = normalize_task_intent(
            &TaskIntentSchema {
                name: "daily".to_string(),
                owner_scope: "conversation:a".to_string(),
                action_type: "redclaw_prompt".to_string(),
                cron: Some("30 9 * * *".to_string()),
                ..TaskIntentSchema::default()
            },
            1_700_000_000_000,
        )
        .expect("normalize");
        assert_eq!(preview.mode, "daily");
        assert_eq!(preview.time.as_deref(), Some("09:30"));
    }
}
