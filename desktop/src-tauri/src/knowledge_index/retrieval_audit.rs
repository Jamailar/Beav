use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tauri::State;

use crate::{
    knowledge_index::{open_catalog_connection, schema::ensure_catalog_ready},
    now_iso, AppState,
};

static RETRIEVAL_RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

fn connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    ensure_catalog_ready(state)?;
    open_catalog_connection(state)
}

pub(crate) fn delete_runs_for_source(
    state: &State<'_, AppState>,
    source_id: &str,
) -> Result<(), String> {
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        r#"
        DELETE FROM knowledge_retrieval_hits
        WHERE run_id IN (
            SELECT run_id FROM knowledge_retrieval_runs WHERE source_id = ?1
        )
        "#,
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_retrieval_runs WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn record_search_run(
    state: &State<'_, AppState>,
    source_id: &str,
    source_name: Option<&str>,
    query: &str,
    search_mode: &str,
    query_profile: &Value,
    query_plan: &Value,
    hits: &[Value],
    evidence_pack: &Value,
) -> Result<String, String> {
    let run_id = new_run_id();
    let created_at = now_iso();
    let mut conn = connection(state)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        r#"
        INSERT INTO knowledge_retrieval_runs (
            run_id, source_id, source_name, query, search_mode,
            query_profile_json, query_plan_json, evidence_pack_json,
            total_hits, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            run_id,
            source_id,
            source_name,
            query,
            search_mode,
            query_profile.to_string(),
            query_plan.to_string(),
            evidence_pack.to_string(),
            hits.len() as i64,
            created_at,
        ],
    )
    .map_err(|error| error.to_string())?;

    let mut stmt = tx
        .prepare(
            r#"
            INSERT INTO knowledge_retrieval_hits (
                run_id, rank, block_id, document_id, anchor_ids_json,
                source_path, page, snippet, ranking_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .map_err(|error| error.to_string())?;
    for (index, hit) in hits.iter().enumerate() {
        let anchor_ids = hit.get("anchorIds").cloned().unwrap_or_else(|| json!([]));
        let ranking = hit_audit_payload(hit);
        stmt.execute(params![
            run_id,
            index as i64 + 1,
            value_string(hit, "blockId"),
            value_string(hit, "documentId"),
            anchor_ids.to_string(),
            value_string(hit, "path"),
            hit.get("page").and_then(Value::as_i64),
            value_string(hit, "snippet").unwrap_or_default(),
            ranking.to_string(),
            created_at,
        ])
        .map_err(|error| error.to_string())?;
    }
    drop(stmt);
    tx.commit().map_err(|error| error.to_string())?;
    Ok(run_id)
}

fn hit_audit_payload(hit: &Value) -> Value {
    let mut payload = hit.get("ranking").cloned().unwrap_or_else(|| json!({}));
    if let Some(object) = payload.as_object_mut() {
        for key in ["visualSource", "visualEvidence", "visualSummary"] {
            if let Some(value) = hit.get(key) {
                object.insert(key.to_string(), value.clone());
            }
        }
    }
    payload
}

fn new_run_id() -> String {
    let sequence = RETRIEVAL_RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("retrieval-{}-{sequence}", now_iso())
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_string_reads_string_fields_only() {
        let value = json!({
            "blockId": "block-1",
            "page": 3
        });
        assert_eq!(value_string(&value, "blockId").as_deref(), Some("block-1"));
        assert_eq!(value_string(&value, "page"), None);
    }

    #[test]
    fn hit_audit_payload_keeps_visual_metadata() {
        let payload = hit_audit_payload(&json!({
            "ranking": { "totalScore": 1.0 },
            "visualSource": { "unitId": "unit-1", "evidenceRefs": ["fact_scene"] },
            "visualEvidence": [{ "id": "fact_scene", "bbox": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 } }],
            "visualSummary": "snow mountain lake"
        }));
        assert_eq!(payload["totalScore"], json!(1.0));
        assert_eq!(payload["visualSource"]["unitId"], json!("unit-1"));
        assert_eq!(payload["visualEvidence"][0]["id"], json!("fact_scene"));
        assert_eq!(payload["visualSummary"], json!("snow mountain lake"));
    }
}
