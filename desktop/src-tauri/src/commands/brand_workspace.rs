use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::persistence::ensure_store_hydrated_for_subjects;
use crate::{
    make_id, now_iso, with_store, workspace_root, write_json_value, AppState, SubjectRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceBrand {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub target_markets: Vec<String>,
    pub category: Option<String>,
    pub product_lines: Vec<String>,
    pub customer_profile: Option<String>,
    pub market_visual_preferences: Value,
    pub visual_dna: Option<String>,
    pub safety_rules: Vec<String>,
    pub source: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceProduct {
    pub id: String,
    pub brand_id: String,
    pub name: String,
    pub description: Option<String>,
    pub product_family: Option<String>,
    pub source_url: Option<String>,
    pub source_platform: Option<String>,
    pub source_product_id: Option<String>,
    pub source_shop_id: Option<String>,
    pub price_signal: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceSku {
    pub id: String,
    pub product_id: String,
    pub name: String,
    pub variant_values: Value,
    pub creative_signals: Value,
    pub price_signal: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceSkuImage {
    pub id: String,
    pub sku_id: String,
    pub relative_path: String,
    pub role: String,
    pub selected_by_default: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceProductBundle {
    pub product: BrandWorkspaceProduct,
    pub skus: Vec<BrandWorkspaceSku>,
    pub sku_images: Vec<BrandWorkspaceSkuImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceBrandBundle {
    pub brand: BrandWorkspaceBrand,
    pub products: Vec<BrandWorkspaceProductBundle>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandMutationInput {
    id: Option<String>,
    name: String,
    description: Option<String>,
    target_markets: Option<Vec<String>>,
    category: Option<String>,
    product_lines: Option<Vec<String>>,
    customer_profile: Option<String>,
    market_visual_preferences: Option<Value>,
    visual_dna: Option<String>,
    safety_rules: Option<Vec<String>>,
    source: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductMutationInput {
    id: Option<String>,
    brand_id: String,
    name: String,
    description: Option<String>,
    product_family: Option<String>,
    source_url: Option<String>,
    source_platform: Option<String>,
    source_product_id: Option<String>,
    source_shop_id: Option<String>,
    price_signal: Option<Value>,
    skus: Option<Vec<SkuMutationInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkuMutationInput {
    id: Option<String>,
    product_id: Option<String>,
    name: String,
    variant_values: Option<Value>,
    creative_signals: Option<Value>,
    price_signal: Option<Value>,
}

fn clean_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn clean_strings(values: Option<Vec<String>>) -> Vec<String> {
    values
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn parse_json_text(value: String) -> Value {
    serde_json::from_str(&value).unwrap_or(Value::Null)
}

fn brand_workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = workspace_root(state)?
        .join("assets")
        .join("brand-workspace");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn brand_workspace_db_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(brand_workspace_root(state)?.join("brand-workspace.sqlite"))
}

fn brand_workspace_ai_index_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = brand_workspace_root(state)?.join("ai-index");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn open_connection(state: &State<'_, AppState>) -> Result<Connection, String> {
    let path = brand_workspace_db_path(state)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS brand_records (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            target_markets_json TEXT NOT NULL DEFAULT '[]',
            category TEXT,
            product_lines_json TEXT NOT NULL DEFAULT '[]',
            customer_profile TEXT,
            market_visual_preferences_json TEXT NOT NULL DEFAULT '{}',
            visual_dna TEXT,
            safety_rules_json TEXT NOT NULL DEFAULT '[]',
            source_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS brand_assets (
            id TEXT PRIMARY KEY,
            brand_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            role TEXT NOT NULL,
            used_for TEXT,
            selected_by_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY(brand_id) REFERENCES brand_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_brand_assets_brand
            ON brand_assets(brand_id, role, id);
        CREATE TABLE IF NOT EXISTS product_records (
            id TEXT PRIMARY KEY,
            brand_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            product_family TEXT,
            source_url TEXT,
            source_platform TEXT,
            source_product_id TEXT,
            source_shop_id TEXT,
            price_signal_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(brand_id) REFERENCES brand_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_products_brand_id
            ON product_records(brand_id, updated_at DESC, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_products_source
            ON product_records(source_platform, source_product_id)
            WHERE source_platform IS NOT NULL AND source_product_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS product_skus (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            name TEXT NOT NULL,
            variant_values_json TEXT NOT NULL DEFAULT '{}',
            creative_signals_json TEXT NOT NULL DEFAULT '{}',
            price_signal_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(product_id) REFERENCES product_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_skus_product_id
            ON product_skus(product_id, updated_at DESC, id);
        CREATE TABLE IF NOT EXISTS sku_reference_images (
            id TEXT PRIMARY KEY,
            sku_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            role TEXT NOT NULL,
            selected_by_default INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY(sku_id) REFERENCES product_skus(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sku_images_sku_id
            ON sku_reference_images(sku_id, role, id);
        "#,
    )
    .map_err(|error| error.to_string())?;
    Ok(conn)
}

fn row_to_brand(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceBrand, rusqlite::Error> {
    Ok(BrandWorkspaceBrand {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        target_markets: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(3)?)
            .unwrap_or_default(),
        category: row.get(4)?,
        product_lines: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(5)?)
            .unwrap_or_default(),
        customer_profile: row.get(6)?,
        market_visual_preferences: parse_json_text(row.get(7)?),
        visual_dna: row.get(8)?,
        safety_rules: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(9)?)
            .unwrap_or_default(),
        source: parse_json_text(row.get(10)?),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn row_to_product(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceProduct, rusqlite::Error> {
    Ok(BrandWorkspaceProduct {
        id: row.get(0)?,
        brand_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        product_family: row.get(4)?,
        source_url: row.get(5)?,
        source_platform: row.get(6)?,
        source_product_id: row.get(7)?,
        source_shop_id: row.get(8)?,
        price_signal: parse_json_text(row.get(9)?),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn row_to_sku(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceSku, rusqlite::Error> {
    Ok(BrandWorkspaceSku {
        id: row.get(0)?,
        product_id: row.get(1)?,
        name: row.get(2)?,
        variant_values: parse_json_text(row.get(3)?),
        creative_signals: parse_json_text(row.get(4)?),
        price_signal: parse_json_text(row.get(5)?),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn row_to_sku_image(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceSkuImage, rusqlite::Error> {
    let selected: i64 = row.get(4)?;
    Ok(BrandWorkspaceSkuImage {
        id: row.get(0)?,
        sku_id: row.get(1)?,
        relative_path: row.get(2)?,
        role: row.get(3)?,
        selected_by_default: selected != 0,
        created_at: row.get(5)?,
    })
}

fn select_brands(conn: &Connection) -> Result<Vec<BrandWorkspaceBrand>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, target_markets_json, category, product_lines_json,
             customer_profile, market_visual_preferences_json, visual_dna, safety_rules_json,
             source_json, created_at, updated_at
             FROM brand_records ORDER BY updated_at DESC, name ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], row_to_brand)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn select_products_for_brand(
    conn: &Connection,
    brand_id: &str,
) -> Result<Vec<BrandWorkspaceProduct>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, brand_id, name, description, product_family, source_url, source_platform,
             source_product_id, source_shop_id, price_signal_json, created_at, updated_at
             FROM product_records WHERE brand_id = ?1 ORDER BY updated_at DESC, name ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![brand_id], row_to_product)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn select_skus_for_product(
    conn: &Connection,
    product_id: &str,
) -> Result<Vec<BrandWorkspaceSku>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, product_id, name, variant_values_json, creative_signals_json,
             price_signal_json, created_at, updated_at
             FROM product_skus WHERE product_id = ?1 ORDER BY updated_at DESC, name ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![product_id], row_to_sku)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn select_images_for_skus(
    conn: &Connection,
    sku_ids: &[String],
) -> Result<Vec<BrandWorkspaceSkuImage>, String> {
    if sku_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(sku_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, sku_id, relative_path, role, selected_by_default, created_at
         FROM sku_reference_images WHERE sku_id IN ({placeholders})
         ORDER BY created_at DESC, id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(sku_ids.iter()), row_to_sku_image)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn brand_bundle(
    conn: &Connection,
    brand: BrandWorkspaceBrand,
) -> Result<BrandWorkspaceBrandBundle, String> {
    let products = select_products_for_brand(conn, &brand.id)?;
    let mut bundles = Vec::new();
    for product in products {
        let skus = select_skus_for_product(conn, &product.id)?;
        let sku_ids = skus.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
        let sku_images = select_images_for_skus(conn, &sku_ids)?;
        bundles.push(BrandWorkspaceProductBundle {
            product,
            skus,
            sku_images,
        });
    }
    Ok(BrandWorkspaceBrandBundle {
        brand,
        products: bundles,
    })
}

fn brand_source_from_subject(subject: &SubjectRecord) -> Value {
    json!({
        "importedFrom": "assets.catalog.json",
        "assetId": subject.id,
    })
}

fn subject_category_name(subject: &SubjectRecord, categories: &[(String, String)]) -> String {
    let Some(category_id) = subject.category_id.as_deref() else {
        return String::new();
    };
    categories
        .iter()
        .find(|(id, _)| id == category_id)
        .map(|(_, name)| name.trim().to_string())
        .unwrap_or_default()
}

fn sync_subject_brands(conn: &Connection, state: &State<'_, AppState>) -> Result<(), String> {
    ensure_store_hydrated_for_subjects(state)?;
    let (categories, subjects) = with_store(state, |store| {
        Ok((
            store
                .categories
                .iter()
                .map(|item| (item.id.clone(), item.name.clone()))
                .collect::<Vec<_>>(),
            store.subjects.clone(),
        ))
    })?;
    let now = now_iso();
    for subject in subjects.iter() {
        if subject_category_name(subject, &categories) != "品牌" {
            continue;
        }
        let source = brand_source_from_subject(subject);
        conn.execute(
            "INSERT INTO brand_records (
                id, name, description, target_markets_json, category, product_lines_json,
                customer_profile, market_visual_preferences_json, visual_dna, safety_rules_json,
                source_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, '[]', NULL, '[]', NULL, '{}', NULL, '[]', ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                source_json = excluded.source_json,
                updated_at = excluded.updated_at",
            params![
                subject.id,
                subject.name,
                subject.description,
                json_text(&source),
                subject.created_at,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    for subject in subjects.iter() {
        if subject_category_name(subject, &categories) != "商品" {
            continue;
        }
        let Some(brand_id) = subject.brand_id.as_deref() else {
            continue;
        };
        let brand_exists: Option<String> = conn
            .query_row(
                "SELECT id FROM brand_records WHERE id = ?1",
                params![brand_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if brand_exists.is_none() {
            continue;
        }
        conn.execute(
            "INSERT INTO product_records (
                id, brand_id, name, description, product_family, source_url, source_platform,
                source_product_id, source_shop_id, price_signal_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'assets_catalog', ?1, NULL, '{}', ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                brand_id = excluded.brand_id,
                name = excluded.name,
                description = excluded.description,
                product_family = excluded.product_family,
                updated_at = excluded.updated_at",
            params![
                subject.id,
                brand_id,
                subject.name,
                subject.description,
                subject.name,
                subject.created_at,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
        for sku in &subject.skus {
            let variant_values = json!(sku
                .attributes
                .iter()
                .map(|item| (item.key.clone(), Value::String(item.value.clone())))
                .collect::<serde_json::Map<String, Value>>());
            conn.execute(
                "INSERT INTO product_skus (
                    id, product_id, name, variant_values_json, creative_signals_json,
                    price_signal_json, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, '{}', '{}', ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    product_id = excluded.product_id,
                    name = excluded.name,
                    variant_values_json = excluded.variant_values_json,
                    updated_at = excluded.updated_at",
                params![
                    sku.id,
                    subject.id,
                    sku.name,
                    json_text(&variant_values),
                    now,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn upsert_brand(
    conn: &Connection,
    input: BrandMutationInput,
) -> Result<BrandWorkspaceBrand, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("品牌名称不能为空".to_string());
    }
    let id = input.id.unwrap_or_else(|| make_id("brand"));
    let now = now_iso();
    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM brand_records WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let created_at = existing_created_at.unwrap_or_else(|| now.clone());
    let target_markets = clean_strings(input.target_markets);
    let product_lines = clean_strings(input.product_lines);
    let safety_rules = clean_strings(input.safety_rules);
    let market_visual_preferences = input.market_visual_preferences.unwrap_or_else(|| json!({}));
    let source = input.source.unwrap_or_else(|| json!({}));
    conn.execute(
        "INSERT INTO brand_records (
            id, name, description, target_markets_json, category, product_lines_json,
            customer_profile, market_visual_preferences_json, visual_dna, safety_rules_json,
            source_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            target_markets_json = excluded.target_markets_json,
            category = excluded.category,
            product_lines_json = excluded.product_lines_json,
            customer_profile = excluded.customer_profile,
            market_visual_preferences_json = excluded.market_visual_preferences_json,
            visual_dna = excluded.visual_dna,
            safety_rules_json = excluded.safety_rules_json,
            source_json = excluded.source_json,
            updated_at = excluded.updated_at",
        params![
            id,
            name,
            clean_string(input.description),
            serde_json::to_string(&target_markets).unwrap_or_else(|_| "[]".to_string()),
            clean_string(input.category),
            serde_json::to_string(&product_lines).unwrap_or_else(|_| "[]".to_string()),
            clean_string(input.customer_profile),
            json_text(&market_visual_preferences),
            clean_string(input.visual_dna),
            serde_json::to_string(&safety_rules).unwrap_or_else(|_| "[]".to_string()),
            json_text(&source),
            created_at,
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    get_brand(conn, &id)
}

fn upsert_product(
    conn: &Connection,
    input: ProductMutationInput,
) -> Result<BrandWorkspaceProductBundle, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("商品名称不能为空".to_string());
    }
    let brand_id = input.brand_id.trim().to_string();
    let brand_exists: Option<String> = conn
        .query_row(
            "SELECT id FROM brand_records WHERE id = ?1",
            params![brand_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if brand_exists.is_none() {
        return Err("品牌不存在".to_string());
    }
    let id = input.id.unwrap_or_else(|| make_id("product"));
    let now = now_iso();
    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM product_records WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let created_at = existing_created_at.unwrap_or_else(|| now.clone());
    let price_signal = input.price_signal.unwrap_or_else(|| json!({}));
    conn.execute(
        "INSERT INTO product_records (
            id, brand_id, name, description, product_family, source_url, source_platform,
            source_product_id, source_shop_id, price_signal_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            brand_id = excluded.brand_id,
            name = excluded.name,
            description = excluded.description,
            product_family = excluded.product_family,
            source_url = excluded.source_url,
            source_platform = excluded.source_platform,
            source_product_id = excluded.source_product_id,
            source_shop_id = excluded.source_shop_id,
            price_signal_json = excluded.price_signal_json,
            updated_at = excluded.updated_at",
        params![
            id,
            brand_id,
            name,
            clean_string(input.description),
            clean_string(input.product_family).or_else(|| Some(name.clone())),
            clean_string(input.source_url),
            clean_string(input.source_platform),
            clean_string(input.source_product_id),
            clean_string(input.source_shop_id),
            json_text(&price_signal),
            created_at,
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    if let Some(skus) = input.skus {
        let mut next_sku_ids = Vec::new();
        for sku in skus {
            let saved_sku = upsert_sku_for_product(conn, &id, sku)?;
            next_sku_ids.push(saved_sku.id);
        }
        if next_sku_ids.is_empty() {
            conn.execute(
                "DELETE FROM product_skus WHERE product_id = ?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        } else {
            let placeholders = std::iter::repeat("?")
                .take(next_sku_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "DELETE FROM product_skus WHERE product_id = ?1 AND id NOT IN ({placeholders})"
            );
            let params =
                std::iter::once(id.as_str()).chain(next_sku_ids.iter().map(String::as_str));
            conn.execute(&sql, rusqlite::params_from_iter(params))
                .map_err(|error| error.to_string())?;
        }
    }
    get_product_bundle(conn, &id)
}

fn upsert_sku_for_product(
    conn: &Connection,
    product_id: &str,
    input: SkuMutationInput,
) -> Result<BrandWorkspaceSku, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("SKU 名称不能为空".to_string());
    }
    let id = input.id.unwrap_or_else(|| make_id("sku"));
    let now = now_iso();
    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM product_skus WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let created_at = existing_created_at.unwrap_or_else(|| now.clone());
    let variant_values = input.variant_values.unwrap_or_else(|| json!({}));
    let creative_signals = input.creative_signals.unwrap_or_else(|| json!({}));
    let price_signal = input.price_signal.unwrap_or_else(|| json!({}));
    conn.execute(
        "INSERT INTO product_skus (
            id, product_id, name, variant_values_json, creative_signals_json,
            price_signal_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            product_id = excluded.product_id,
            name = excluded.name,
            variant_values_json = excluded.variant_values_json,
            creative_signals_json = excluded.creative_signals_json,
            price_signal_json = excluded.price_signal_json,
            updated_at = excluded.updated_at",
        params![
            id,
            product_id,
            name,
            json_text(&variant_values),
            json_text(&creative_signals),
            json_text(&price_signal),
            created_at,
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    get_sku(conn, &id)
}

fn get_brand(conn: &Connection, id: &str) -> Result<BrandWorkspaceBrand, String> {
    conn.query_row(
        "SELECT id, name, description, target_markets_json, category, product_lines_json,
         customer_profile, market_visual_preferences_json, visual_dna, safety_rules_json,
         source_json, created_at, updated_at
         FROM brand_records WHERE id = ?1",
        params![id],
        row_to_brand,
    )
    .map_err(|error| error.to_string())
}

fn get_product(conn: &Connection, id: &str) -> Result<BrandWorkspaceProduct, String> {
    conn.query_row(
        "SELECT id, brand_id, name, description, product_family, source_url, source_platform,
         source_product_id, source_shop_id, price_signal_json, created_at, updated_at
         FROM product_records WHERE id = ?1",
        params![id],
        row_to_product,
    )
    .map_err(|error| error.to_string())
}

fn get_sku(conn: &Connection, id: &str) -> Result<BrandWorkspaceSku, String> {
    conn.query_row(
        "SELECT id, product_id, name, variant_values_json, creative_signals_json,
         price_signal_json, created_at, updated_at
         FROM product_skus WHERE id = ?1",
        params![id],
        row_to_sku,
    )
    .map_err(|error| error.to_string())
}

fn get_product_bundle(conn: &Connection, id: &str) -> Result<BrandWorkspaceProductBundle, String> {
    let product = get_product(conn, id)?;
    let skus = select_skus_for_product(conn, id)?;
    let sku_ids = skus.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
    let sku_images = select_images_for_skus(conn, &sku_ids)?;
    Ok(BrandWorkspaceProductBundle {
        product,
        skus,
        sku_images,
    })
}

fn rebuild_ai_index_with_connection(
    conn: &Connection,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let index_root = brand_workspace_ai_index_root(state)?;
    let brands = select_brands(conn)?;
    let generated_at = now_iso();
    let index = brands
        .iter()
        .map(|brand| {
            let products = select_products_for_brand(conn, &brand.id).unwrap_or_default();
            json!({
                "id": brand.id,
                "name": brand.name,
                "description": brand.description,
                "productCount": products.len(),
                "contextPath": format!("brand_{}.context.json", brand.id),
            })
        })
        .collect::<Vec<_>>();
    write_json_value(
        &index_root.join("brands.index.json"),
        &json!({
            "generated": true,
            "readOnly": true,
            "canonicalSource": "brand-workspace.sqlite",
            "generatedAt": generated_at,
            "brands": index,
        }),
    )?;
    for brand in brands {
        let bundle = brand_bundle(conn, brand)?;
        write_json_value(
            &index_root.join(format!("brand_{}.context.json", bundle.brand.id)),
            &json!({
                "generated": true,
                "readOnly": true,
                "canonicalSource": "brand-workspace.sqlite",
                "generatedAt": generated_at,
                "brand": bundle.brand,
                "products": bundle.products,
            }),
        )?;
    }
    Ok(())
}

fn prepare_workspace(state: &State<'_, AppState>) -> Result<Connection, String> {
    let conn = open_connection(state)?;
    sync_subject_brands(&conn, state)?;
    rebuild_ai_index_with_connection(&conn, state)?;
    Ok(conn)
}

pub fn handle_brand_workspace_channel(
    state: &State<'_, AppState>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    if !matches!(
        channel,
        "brand-workspace:list"
            | "brand-workspace:get"
            | "brand-workspace:brand:upsert"
            | "brand-workspace:product:upsert"
            | "brand-workspace:sku:upsert"
            | "brand-workspace:rebuild-ai-index"
    ) {
        return None;
    }
    let result = (|| match channel {
        "brand-workspace:list" => {
            let conn = prepare_workspace(state)?;
            let brands = select_brands(&conn)?;
            let mut bundles = Vec::new();
            for brand in brands {
                bundles.push(brand_bundle(&conn, brand)?);
            }
            Ok(json!({ "success": true, "brands": bundles }))
        }
        "brand-workspace:get" => {
            let conn = prepare_workspace(state)?;
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "缺少品牌 id".to_string())?;
            let brand = get_brand(&conn, id)?;
            Ok(json!({ "success": true, "brand": brand_bundle(&conn, brand)? }))
        }
        "brand-workspace:brand:upsert" => {
            let conn = prepare_workspace(state)?;
            let input: BrandMutationInput =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            let brand = upsert_brand(&conn, input)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true, "brand": brand }))
        }
        "brand-workspace:product:upsert" => {
            let conn = prepare_workspace(state)?;
            let input: ProductMutationInput =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            let product = upsert_product(&conn, input)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true, "product": product }))
        }
        "brand-workspace:sku:upsert" => {
            let conn = prepare_workspace(state)?;
            let input: SkuMutationInput =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            let product_id = input
                .product_id
                .clone()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "缺少商品 id".to_string())?;
            let sku = upsert_sku_for_product(&conn, &product_id, input)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true, "sku": sku }))
        }
        "brand-workspace:rebuild-ai-index" => {
            let conn = prepare_workspace(state)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true }))
        }
        _ => unreachable!(),
    })();
    Some(result)
}
