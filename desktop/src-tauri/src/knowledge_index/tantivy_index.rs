use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tantivy::{
    Document, Index,
    collector::TopDocs,
    query::QueryParser,
    schema::{Field, STORED, STRING, Schema, TEXT, TantivyDocument},
};
use tauri::State;

use crate::{
    AppState,
    knowledge_index::{catalog_root, document_blocks::DocumentBlockRecord},
};

const INDEX_DIR_NAME: &str = "tantivy-blocks";
const WRITER_MEMORY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct TantivyBlockHit {
    pub block_id: String,
    pub score: f32,
}

#[derive(Debug, Clone)]
struct TantivyFields {
    block_id: Field,
    source_id: Field,
    title: Field,
    relative_path: Field,
    text: Field,
    normalized_text: Field,
}

pub(crate) fn rebuild_index(
    state: &State<'_, AppState>,
    blocks: &[DocumentBlockRecord],
) -> Result<(), String> {
    let index_path = index_path(state)?;
    if index_path.exists() {
        fs::remove_dir_all(&index_path).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&index_path).map_err(|error| error.to_string())?;
    let (schema, fields) = build_schema();
    let index = Index::create_in_dir(&index_path, schema).map_err(|error| error.to_string())?;
    let mut writer = index
        .writer(WRITER_MEMORY_BYTES)
        .map_err(|error| error.to_string())?;
    for block in blocks {
        let mut doc = TantivyDocument::new();
        doc.add_text(fields.block_id, &block.block_id);
        doc.add_text(fields.source_id, &block.source_id);
        if let Some(title) = block.title.as_deref() {
            doc.add_text(fields.title, title);
        }
        doc.add_text(fields.relative_path, &block.relative_path);
        doc.add_text(fields.text, &block.text);
        doc.add_text(fields.normalized_text, &block.normalized_text);
        writer
            .add_document(doc)
            .map_err(|error| error.to_string())?;
    }
    writer.commit().map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn search_block_ids(
    state: &State<'_, AppState>,
    source_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<TantivyBlockHit>, String> {
    let index_path = index_path(state)?;
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let index = Index::open_in_dir(&index_path).map_err(|error| error.to_string())?;
    let schema = index.schema();
    let fields = fields_from_schema(&schema)?;
    let reader = index.reader().map_err(|error| error.to_string())?;
    let searcher = reader.searcher();
    let parser = QueryParser::for_index(
        &index,
        vec![
            fields.title,
            fields.relative_path,
            fields.text,
            fields.normalized_text,
        ],
    );
    let parsed = parser
        .parse_query(query)
        .map_err(|error| error.to_string())?;
    let docs = searcher
        .search(
            &parsed,
            &TopDocs::with_limit(limit.saturating_mul(8).max(limit).max(20)).order_by_score(),
        )
        .map_err(|error| error.to_string())?;
    let mut hits = Vec::new();
    for (score, address) in docs {
        let doc = searcher
            .doc::<TantivyDocument>(address)
            .map_err(|error| error.to_string())?;
        if doc_text(&schema, &doc, "source_id").as_deref() != Some(source_id) {
            continue;
        }
        let Some(block_id) = doc_text(&schema, &doc, "block_id") else {
            continue;
        };
        hits.push(TantivyBlockHit { block_id, score });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn index_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(catalog_root(state)?.join(INDEX_DIR_NAME))
}

fn build_schema() -> (Schema, TantivyFields) {
    let mut builder = Schema::builder();
    let block_id = builder.add_text_field("block_id", STRING | STORED);
    let source_id = builder.add_text_field("source_id", STRING | STORED);
    let title = builder.add_text_field("title", TEXT | STORED);
    let relative_path = builder.add_text_field("relative_path", TEXT | STORED);
    let text = builder.add_text_field("text", TEXT | STORED);
    let normalized_text = builder.add_text_field("normalized_text", TEXT | STORED);
    let schema = builder.build();
    (
        schema,
        TantivyFields {
            block_id,
            source_id,
            title,
            relative_path,
            text,
            normalized_text,
        },
    )
}

fn fields_from_schema(schema: &Schema) -> Result<TantivyFields, String> {
    Ok(TantivyFields {
        block_id: schema
            .get_field("block_id")
            .map_err(|error| error.to_string())?,
        source_id: schema
            .get_field("source_id")
            .map_err(|error| error.to_string())?,
        title: schema
            .get_field("title")
            .map_err(|error| error.to_string())?,
        relative_path: schema
            .get_field("relative_path")
            .map_err(|error| error.to_string())?,
        text: schema
            .get_field("text")
            .map_err(|error| error.to_string())?,
        normalized_text: schema
            .get_field("normalized_text")
            .map_err(|error| error.to_string())?,
    })
}

fn doc_text(schema: &Schema, doc: &TantivyDocument, field_name: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(&doc.to_json(schema)).ok()?;
    value
        .get(field_name)
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_doc_text_round_trips_block_id() {
        let (schema, fields) = build_schema();
        let mut doc = TantivyDocument::new();
        doc.add_text(fields.block_id, "source:file.txt#0");
        doc.add_text(fields.source_id, "source");
        doc.add_text(fields.text, "合同解除条款");

        assert_eq!(
            doc_text(&schema, &doc, "block_id").as_deref(),
            Some("source:file.txt#0")
        );
        assert_eq!(
            doc_text(&schema, &doc, "source_id").as_deref(),
            Some("source")
        );
    }
}
