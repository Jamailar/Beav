use std::collections::BTreeMap;

use rusqlite::{params, Connection};

use super::{
    BrandWorkspaceAssetRef, BrandWorkspaceBrand, BrandWorkspaceBrandBundle, BrandWorkspaceProduct,
    BrandWorkspaceProductBundle, BrandWorkspaceProductDetailPage, BrandWorkspaceSku,
};

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

fn row_to_detail_page(
    row: &rusqlite::Row<'_>,
) -> Result<BrandWorkspaceProductDetailPage, rusqlite::Error> {
    Ok(BrandWorkspaceProductDetailPage {
        id: row.get(0)?,
        product_id: row.get(1)?,
        platform: row.get(2)?,
        market: row.get(3)?,
        locale: row.get(4)?,
        title: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub(super) fn select_brands(conn: &Connection) -> Result<Vec<BrandWorkspaceBrand>, String> {
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

fn select_detail_pages_for_product(
    conn: &Connection,
    product_id: &str,
) -> Result<Vec<BrandWorkspaceProductDetailPage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, product_id, platform, market, locale, title, created_at, updated_at
             FROM product_detail_pages
             WHERE product_id = ?1
             ORDER BY platform ASC, market ASC, locale ASC, updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![product_id], row_to_detail_page)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(super) fn brand_bundle(
    conn: &Connection,
    brand: BrandWorkspaceBrand,
) -> Result<BrandWorkspaceBrandBundle, String> {
    let products = select_products_for_brand(conn, &brand.id)?;
    let brand_assets = select_asset_refs(conn, "brand", &[brand.id.clone()])?;
    let mut bundles = Vec::new();
    for product in products {
        let skus = select_skus_for_product(conn, &product.id)?;
        let assets = select_asset_refs(conn, "product", &[product.id.clone()])?;
        let sku_ids = skus.iter().map(|sku| sku.id.clone()).collect::<Vec<_>>();
        let sku_asset_refs = select_asset_refs(conn, "sku", &sku_ids)?;
        let mut sku_assets: BTreeMap<String, Vec<BrandWorkspaceAssetRef>> = BTreeMap::new();
        for asset in sku_asset_refs {
            sku_assets
                .entry(asset.owner_id.clone())
                .or_default()
                .push(asset);
        }
        let detail_pages = select_detail_pages_for_product(conn, &product.id)?;
        let detail_page_ids = detail_pages
            .iter()
            .map(|page| page.id.clone())
            .collect::<Vec<_>>();
        let detail_page_refs = select_asset_refs(conn, "product_detail_page", &detail_page_ids)?;
        let mut detail_page_assets: BTreeMap<String, Vec<BrandWorkspaceAssetRef>> = BTreeMap::new();
        for asset in detail_page_refs {
            detail_page_assets
                .entry(asset.owner_id.clone())
                .or_default()
                .push(asset);
        }
        bundles.push(BrandWorkspaceProductBundle {
            product,
            skus,
            assets,
            sku_assets,
            detail_pages,
            detail_page_assets,
        });
    }
    Ok(BrandWorkspaceBrandBundle {
        brand,
        assets: brand_assets,
        products: bundles,
    })
}

pub(super) fn get_brand(conn: &Connection, id: &str) -> Result<BrandWorkspaceBrand, String> {
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

pub(super) fn get_sku(conn: &Connection, id: &str) -> Result<BrandWorkspaceSku, String> {
    conn.query_row(
        "SELECT id, product_id, name, variant_text, created_at, updated_at
         FROM product_skus WHERE id = ?1",
        params![id],
        row_to_sku,
    )
    .map_err(|error| error.to_string())
}

pub(super) fn get_product_bundle(
    conn: &Connection,
    id: &str,
) -> Result<BrandWorkspaceProductBundle, String> {
    let product = get_product(conn, id)?;
    let skus = select_skus_for_product(conn, id)?;
    let assets = select_asset_refs(conn, "product", &[product.id.clone()])?;
    let sku_ids = skus.iter().map(|sku| sku.id.clone()).collect::<Vec<_>>();
    let sku_asset_refs = select_asset_refs(conn, "sku", &sku_ids)?;
    let mut sku_assets: BTreeMap<String, Vec<BrandWorkspaceAssetRef>> = BTreeMap::new();
    for asset in sku_asset_refs {
        sku_assets
            .entry(asset.owner_id.clone())
            .or_default()
            .push(asset);
    }
    let detail_pages = select_detail_pages_for_product(conn, id)?;
    let detail_page_ids = detail_pages
        .iter()
        .map(|page| page.id.clone())
        .collect::<Vec<_>>();
    let detail_page_refs = select_asset_refs(conn, "product_detail_page", &detail_page_ids)?;
    let mut detail_page_assets: BTreeMap<String, Vec<BrandWorkspaceAssetRef>> = BTreeMap::new();
    for asset in detail_page_refs {
        detail_page_assets
            .entry(asset.owner_id.clone())
            .or_default()
            .push(asset);
    }
    Ok(BrandWorkspaceProductBundle {
        product,
        skus,
        assets,
        sku_assets,
        detail_pages,
        detail_page_assets,
    })
}
