use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;

use super::brand_workspace_assets::sync_asset_images;
use super::brand_workspace_queries::{get_brand, get_product_bundle, get_sku};
use super::{BrandWorkspaceBrand, BrandWorkspaceProductBundle, BrandWorkspaceSku};
use crate::{make_id, now_iso, AppState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrandMutationInput {
    id: Option<String>,
    name: String,
    description: Option<String>,
    images: Option<Vec<AssetMutationInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProductMutationInput {
    id: Option<String>,
    brand_id: String,
    name: String,
    description: Option<String>,
    images: Option<Vec<AssetMutationInput>>,
    skus: Option<Vec<SkuMutationInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkuMutationInput {
    id: Option<String>,
    pub(super) product_id: Option<String>,
    name: String,
    variant_text: Option<String>,
    images: Option<Vec<AssetMutationInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProductDetailPageMutationInput {
    id: Option<String>,
    product_id: String,
    platform: String,
    market: Option<String>,
    locale: Option<String>,
    title: Option<String>,
    images: Option<Vec<AssetMutationInput>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AssetMutationInput {
    pub(super) id: Option<String>,
    pub(super) path: Option<String>,
    pub(super) data_url: Option<String>,
    pub(super) name: Option<String>,
    pub(super) role: Option<String>,
}

fn clean_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

pub(super) fn upsert_brand(
    conn: &Connection,
    state: &State<'_, AppState>,
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
    if let Some(images) = input.images {
        sync_asset_images(conn, state, "brand", &id, images)?;
    }
    get_brand(conn, &id)
}

pub(super) fn upsert_product(
    conn: &Connection,
    state: &State<'_, AppState>,
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
    if let Some(images) = input.images {
        sync_asset_images(conn, state, "product", &id, images)?;
    }
    if let Some(skus) = input.skus {
        let mut next_sku_ids = Vec::new();
        for sku in skus {
            let saved_sku = upsert_sku_for_product(conn, state, &id, sku)?;
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
        conn.execute(
            "DELETE FROM asset_refs
             WHERE owner_type = 'sku'
               AND owner_id NOT IN (SELECT id FROM product_skus)",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    get_product_bundle(conn, &id)
}

pub(super) fn upsert_sku_for_product(
    conn: &Connection,
    state: &State<'_, AppState>,
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
    if let Some(images) = input.images {
        sync_asset_images(conn, state, "sku", &id, images)?;
    }
    get_sku(conn, &id)
}

pub(super) fn upsert_detail_page(
    conn: &Connection,
    state: &State<'_, AppState>,
    input: ProductDetailPageMutationInput,
) -> Result<BrandWorkspaceProductBundle, String> {
    let product_id = input.product_id.trim().to_string();
    if product_id.is_empty() {
        return Err("缺少商品 id".to_string());
    }
    let product_exists: Option<String> = conn
        .query_row(
            "SELECT id FROM product_records WHERE id = ?1",
            params![product_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if product_exists.is_none() {
        return Err("商品不存在".to_string());
    }
    let platform = input.platform.trim().to_string();
    if platform.is_empty() {
        return Err("缺少电商平台".to_string());
    }
    let market = input
        .market
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let locale = input
        .locale
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let input_id = input
        .id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let now = now_iso();
    if let Some(existing_id) = input_id.as_deref() {
        let existing_created_at: Option<String> = conn
            .query_row(
                "SELECT created_at FROM product_detail_pages WHERE id = ?1",
                params![existing_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing_created_at.is_some() {
            conn.execute(
                "UPDATE product_detail_pages
                 SET product_id = ?2, platform = ?3, market = ?4, locale = ?5, title = ?6, updated_at = ?7
                 WHERE id = ?1",
                params![
                    existing_id,
                    product_id,
                    platform,
                    market,
                    locale,
                    clean_string(input.title),
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            if let Some(images) = input.images {
                sync_asset_images(conn, state, "product_detail_page", existing_id, images)?;
            }
            return get_product_bundle(conn, &product_id);
        }
    }
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT id, created_at FROM product_detail_pages
             WHERE product_id = ?1 AND platform = ?2 AND market = ?3 AND locale = ?4",
            params![product_id, platform, market, locale],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let id = input_id
        .or_else(|| existing.as_ref().map(|item| item.0.clone()))
        .unwrap_or_else(|| make_id("detail_page"));
    let created_at = existing.map(|item| item.1).unwrap_or_else(|| now.clone());
    conn.execute(
        "INSERT INTO product_detail_pages (
            id, product_id, platform, market, locale, title, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(product_id, platform, market, locale) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at",
        params![
            id,
            product_id,
            platform,
            market,
            locale,
            clean_string(input.title),
            created_at,
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    if let Some(images) = input.images {
        sync_asset_images(conn, state, "product_detail_page", &id, images)?;
    }
    get_product_bundle(conn, &product_id)
}
