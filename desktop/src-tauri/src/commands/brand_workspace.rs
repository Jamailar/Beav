#[path = "brand_workspace/ai_index.rs"]
mod brand_workspace_ai_index;
#[path = "brand_workspace/assets.rs"]
mod brand_workspace_assets;
#[path = "brand_workspace/mutations.rs"]
mod brand_workspace_mutations;
#[path = "brand_workspace/queries.rs"]
mod brand_workspace_queries;
#[path = "brand_workspace/storage.rs"]
mod brand_workspace_storage;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::State;

use crate::{now_iso, AppState};
use brand_workspace_ai_index::rebuild_ai_index_with_connection;
use brand_workspace_mutations::{
    upsert_brand, upsert_detail_page, upsert_product, upsert_sku_for_product, BrandMutationInput,
    ProductDetailPageMutationInput, ProductMutationInput, SkuMutationInput,
};
use brand_workspace_queries::{brand_bundle, get_brand, select_brands};
use brand_workspace_storage::{brand_workspace_ai_index_root, open_connection};

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
pub(crate) struct BrandWorkspaceProductDetailPage {
    pub id: String,
    pub product_id: String,
    pub platform: String,
    pub market: String,
    pub locale: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceProductBundle {
    pub product: BrandWorkspaceProduct,
    pub skus: Vec<BrandWorkspaceSku>,
    pub assets: Vec<BrandWorkspaceAssetRef>,
    pub sku_assets: BTreeMap<String, Vec<BrandWorkspaceAssetRef>>,
    pub detail_pages: Vec<BrandWorkspaceProductDetailPage>,
    pub detail_page_assets: BTreeMap<String, Vec<BrandWorkspaceAssetRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrandWorkspaceBrandBundle {
    pub brand: BrandWorkspaceBrand,
    pub assets: Vec<BrandWorkspaceAssetRef>,
    pub products: Vec<BrandWorkspaceProductBundle>,
}

fn ensure_sample_brand_workspace(conn: &Connection) -> Result<(), String> {
    let brand_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM brand_records", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if brand_count > 0 {
        return Ok(());
    }
    let now = now_iso();
    conn.execute(
        "INSERT INTO brand_records (
            id, name, description, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "brand_sample_apple",
            "Apple",
            "示例品牌，用来展示品牌资产如何绑定多个商品。",
            now,
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    let sample_assets = [
        (
            "asset_sample_apple_logo",
            "brand",
            "brand_sample_apple",
            "https://commons.wikimedia.org/wiki/Special:FilePath/Apple%20Logo.svg",
        ),
        (
            "asset_sample_iphone_image",
            "product",
            "product_sample_iphone",
            "https://commons.wikimedia.org/wiki/Special:FilePath/Apple%20iPhones.jpg",
        ),
        (
            "asset_sample_ipad_image",
            "product",
            "product_sample_ipad",
            "https://commons.wikimedia.org/wiki/Special:FilePath/Apple%20iPad.jpg",
        ),
    ];
    for (id, owner_type, owner_id, path) in sample_assets {
        conn.execute(
            "INSERT INTO asset_refs (
                id, owner_type, owner_id, path, role, created_at
             ) VALUES (?1, ?2, ?3, ?4, 'image', ?5)",
            params![id, owner_type, owner_id, path, now],
        )
        .map_err(|error| error.to_string())?;
    }
    let products = [
        (
            "product_sample_iphone",
            "iPhone",
            "示例商品：手机产品线，可以继续维护颜色、容量、版本等 SKU。",
        ),
        (
            "product_sample_ipad",
            "iPad",
            "示例商品：平板产品线，可以继续维护尺寸、颜色、存储容量等 SKU。",
        ),
    ];
    for (id, name, description) in products {
        conn.execute(
            "INSERT INTO product_records (
                id, brand_id, name, description, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, "brand_sample_apple", name, description, now, now,],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn prepare_workspace(state: &State<'_, AppState>) -> Result<Connection, String> {
    let conn = open_connection(state)?;
    ensure_sample_brand_workspace(&conn)?;
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
            | "brand-workspace:product-detail-page:upsert"
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
            let brand = upsert_brand(&conn, state, input)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true, "brand": brand }))
        }
        "brand-workspace:product:upsert" => {
            let conn = prepare_workspace(state)?;
            let input: ProductMutationInput =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            let product = upsert_product(&conn, state, input)?;
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
            let sku = upsert_sku_for_product(&conn, state, &product_id, input)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true, "sku": sku }))
        }
        "brand-workspace:product-detail-page:upsert" => {
            let conn = prepare_workspace(state)?;
            let input: ProductDetailPageMutationInput =
                serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
            let product = upsert_detail_page(&conn, state, input)?;
            rebuild_ai_index_with_connection(&conn, state)?;
            Ok(json!({ "success": true, "product": product }))
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
