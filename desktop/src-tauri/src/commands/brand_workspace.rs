use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::State;

use crate::persistence::ensure_store_hydrated_for_subjects;
use crate::{make_id, now_iso, with_store, workspace_root, AppState, SubjectRecord};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceBrand {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceSku {
    pub id: String,
    pub product_id: String,
    pub name: String,
    pub variant_text: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceAssetRef {
    pub id: String,
    pub owner_type: String,
    pub owner_id: String,
    pub path: String,
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceProductBundle {
    pub product: BrandWorkspaceProduct,
    pub skus: Vec<BrandWorkspaceSku>,
    pub assets: Vec<BrandWorkspaceAssetRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceBrandBundle {
    pub brand: BrandWorkspaceBrand,
    pub assets: Vec<BrandWorkspaceAssetRef>,
    pub products: Vec<BrandWorkspaceProductBundle>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandMutationInput {
    id: Option<String>,
    name: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductMutationInput {
    id: Option<String>,
    brand_id: String,
    name: String,
    description: Option<String>,
    skus: Option<Vec<SkuMutationInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkuMutationInput {
    id: Option<String>,
    product_id: Option<String>,
    name: String,
    variant_text: Option<String>,
}

fn clean_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
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
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_refs (
            id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            path TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_asset_refs_owner
            ON asset_refs(owner_type, owner_id, role, id);
        CREATE TABLE IF NOT EXISTS product_records (
            id TEXT PRIMARY KEY,
            brand_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(brand_id) REFERENCES brand_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_products_brand_id
            ON product_records(brand_id, updated_at DESC, id);
        CREATE TABLE IF NOT EXISTS product_skus (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            name TEXT NOT NULL,
            variant_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(product_id) REFERENCES product_records(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_skus_product_id
            ON product_skus(product_id, updated_at DESC, id);
        "#,
    )
    .map_err(|error| error.to_string())?;
    ensure_column(
        &conn,
        "product_skus",
        "variant_text",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(conn)
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if columns.iter().any(|item| item == column) {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn row_to_brand(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceBrand, rusqlite::Error> {
    Ok(BrandWorkspaceBrand {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn row_to_product(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceProduct, rusqlite::Error> {
    Ok(BrandWorkspaceProduct {
        id: row.get(0)?,
        brand_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_sku(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceSku, rusqlite::Error> {
    Ok(BrandWorkspaceSku {
        id: row.get(0)?,
        product_id: row.get(1)?,
        name: row.get(2)?,
        variant_text: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_asset_ref(row: &rusqlite::Row<'_>) -> Result<BrandWorkspaceAssetRef, rusqlite::Error> {
    Ok(BrandWorkspaceAssetRef {
        id: row.get(0)?,
        owner_type: row.get(1)?,
        owner_id: row.get(2)?,
        path: row.get(3)?,
        role: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn select_brands(conn: &Connection) -> Result<Vec<BrandWorkspaceBrand>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, created_at, updated_at
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
            "SELECT id, brand_id, name, description, created_at, updated_at
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
            "SELECT id, product_id, name, variant_text, created_at, updated_at
             FROM product_skus WHERE product_id = ?1 ORDER BY updated_at DESC, name ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![product_id], row_to_sku)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn select_asset_refs(
    conn: &Connection,
    owner_type: &str,
    owner_ids: &[String],
) -> Result<Vec<BrandWorkspaceAssetRef>, String> {
    if owner_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(owner_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT id, owner_type, owner_id, path, role, created_at
         FROM asset_refs WHERE owner_type = ?1 AND owner_id IN ({placeholders})
         ORDER BY created_at DESC, id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let params = std::iter::once(owner_type).chain(owner_ids.iter().map(String::as_str));
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), row_to_asset_ref)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn brand_bundle(
    conn: &Connection,
    brand: BrandWorkspaceBrand,
) -> Result<BrandWorkspaceBrandBundle, String> {
    let products = select_products_for_brand(conn, &brand.id)?;
    let brand_assets = select_asset_refs(conn, "brand", &[brand.id.clone()])?;
    let mut bundles = Vec::new();
    for product in products {
        let skus = select_skus_for_product(conn, &product.id)?;
        let assets = select_asset_refs(conn, "product", &[product.id.clone()])?;
        bundles.push(BrandWorkspaceProductBundle {
            product,
            skus,
            assets,
        });
    }
    Ok(BrandWorkspaceBrandBundle {
        brand,
        assets: brand_assets,
        products: bundles,
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
        conn.execute(
            "INSERT INTO brand_records (
                id, name, description, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                updated_at = excluded.updated_at",
            params![
                subject.id,
                subject.name,
                subject.description,
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
                id, brand_id, name, description, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                brand_id = excluded.brand_id,
                name = excluded.name,
                description = excluded.description,
                updated_at = excluded.updated_at",
            params![
                subject.id,
                brand_id,
                subject.name,
                subject.description,
                subject.created_at,
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
        for sku in &subject.skus {
            let variant_text = sku
                .attributes
                .iter()
                .filter_map(|item| {
                    let key = item.key.trim();
                    let value = item.value.trim();
                    if key.is_empty() && value.is_empty() {
                        None
                    } else if key.is_empty() {
                        Some(value.to_string())
                    } else if value.is_empty() {
                        Some(key.to_string())
                    } else {
                        Some(format!("{key}: {value}"))
                    }
                })
                .collect::<Vec<_>>()
                .join("; ");
            conn.execute(
                "INSERT INTO product_skus (
                    id, product_id, name, variant_text, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    product_id = excluded.product_id,
                    name = excluded.name,
                    variant_text = excluded.variant_text,
                    updated_at = excluded.updated_at",
                params![sku.id, subject.id, sku.name, variant_text, now, now],
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
    conn.execute(
        "INSERT INTO brand_records (
            id, name, description, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            updated_at = excluded.updated_at",
        params![id, name, clean_string(input.description), created_at, now],
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
    conn.execute(
        "INSERT INTO product_records (
            id, brand_id, name, description, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            brand_id = excluded.brand_id,
            name = excluded.name,
            description = excluded.description,
            updated_at = excluded.updated_at",
        params![
            id,
            brand_id,
            name,
            clean_string(input.description),
            created_at,
            now
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
    let variant_text = input
        .variant_text
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    conn.execute(
        "INSERT INTO product_skus (
            id, product_id, name, variant_text, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            product_id = excluded.product_id,
            name = excluded.name,
            variant_text = excluded.variant_text,
            updated_at = excluded.updated_at",
        params![id, product_id, name, variant_text, created_at, now],
    )
    .map_err(|error| error.to_string())?;
    get_sku(conn, &id)
}

fn get_brand(conn: &Connection, id: &str) -> Result<BrandWorkspaceBrand, String> {
    conn.query_row(
        "SELECT id, name, description, created_at, updated_at
         FROM brand_records WHERE id = ?1",
        params![id],
        row_to_brand,
    )
    .map_err(|error| error.to_string())
}

fn get_product(conn: &Connection, id: &str) -> Result<BrandWorkspaceProduct, String> {
    conn.query_row(
        "SELECT id, brand_id, name, description, created_at, updated_at
         FROM product_records WHERE id = ?1",
        params![id],
        row_to_product,
    )
    .map_err(|error| error.to_string())
}

fn get_sku(conn: &Connection, id: &str) -> Result<BrandWorkspaceSku, String> {
    conn.query_row(
        "SELECT id, product_id, name, variant_text, created_at, updated_at
         FROM product_skus WHERE id = ?1",
        params![id],
        row_to_sku,
    )
    .map_err(|error| error.to_string())
}

fn get_product_bundle(conn: &Connection, id: &str) -> Result<BrandWorkspaceProductBundle, String> {
    let product = get_product(conn, id)?;
    let skus = select_skus_for_product(conn, id)?;
    let assets = select_asset_refs(conn, "product", &[product.id.clone()])?;
    Ok(BrandWorkspaceProductBundle {
        product,
        skus,
        assets,
    })
}

fn markdown_line(value: Option<&str>) -> &str {
    value
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("未填写")
}

fn asset_refs_markdown(assets: &[BrandWorkspaceAssetRef]) -> String {
    if assets.is_empty() {
        return "- 未绑定\n".to_string();
    }
    assets
        .iter()
        .map(|asset| format!("- {}: {}\n", asset.role, asset.path))
        .collect::<String>()
}

fn brand_markdown(bundle: &BrandWorkspaceBrandBundle, generated_at: &str) -> String {
    let mut markdown = String::new();
    markdown.push_str(&format!("# 品牌：{}\n\n", bundle.brand.name));
    markdown.push_str(
        "<!-- generated: true; readOnly: true; canonicalSource: brand-workspace.sqlite -->\n\n",
    );
    markdown.push_str(&format!("生成时间：{generated_at}\n\n"));
    markdown.push_str("## 品牌描述\n\n");
    markdown.push_str(markdown_line(bundle.brand.description.as_deref()));
    markdown.push_str("\n\n## 品牌图片\n\n");
    markdown.push_str(&asset_refs_markdown(&bundle.assets));
    markdown.push('\n');
    for product_bundle in &bundle.products {
        markdown.push_str(&format!("## 商品：{}\n\n", product_bundle.product.name));
        markdown.push_str("### 商品描述\n\n");
        markdown.push_str(markdown_line(product_bundle.product.description.as_deref()));
        markdown.push_str("\n\n### 商品图片\n\n");
        markdown.push_str(&asset_refs_markdown(&product_bundle.assets));
        markdown.push_str("\n### SKU\n\n");
        if product_bundle.skus.is_empty() {
            markdown.push_str("- 未创建 SKU\n\n");
        } else {
            for sku in &product_bundle.skus {
                let variant_text = sku.variant_text.trim();
                if variant_text.is_empty() {
                    markdown.push_str(&format!("- {}\n", sku.name));
                } else {
                    markdown.push_str(&format!("- {}：{}\n", sku.name, variant_text));
                }
            }
            markdown.push('\n');
        }
    }
    markdown
}

fn rebuild_ai_index_with_connection(
    conn: &Connection,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let index_root = brand_workspace_ai_index_root(state)?;
    let brands = select_brands(conn)?;
    let generated_at = now_iso();
    let _ = fs::remove_file(index_root.join("brands.index.json"));
    for entry in fs::read_dir(&index_root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if file_name.starts_with("brand_") && file_name.ends_with(".context.json") {
            let _ = fs::remove_file(path);
        }
    }
    let mut index = String::new();
    index.push_str("# 品牌资产索引\n\n");
    index.push_str(
        "<!-- generated: true; readOnly: true; canonicalSource: brand-workspace.sqlite -->\n\n",
    );
    index.push_str(&format!("生成时间：{generated_at}\n\n"));
    for brand in brands {
        let bundle = brand_bundle(conn, brand)?;
        let context_file_name = format!("brand_{}.md", bundle.brand.id);
        index.push_str(&format!(
            "- [{}]({})：{} 个商品\n",
            bundle.brand.name,
            context_file_name,
            bundle.products.len()
        ));
        fs::write(
            index_root.join(context_file_name),
            brand_markdown(&bundle, &generated_at),
        )
        .map_err(|error| error.to_string())?;
    }
    fs::write(index_root.join("brands.index.md"), index).map_err(|error| error.to_string())?;
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
