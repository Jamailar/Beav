use rusqlite::Connection;
use std::fs;
use tauri::State;

use super::{
    brand_bundle, brand_workspace_ai_index_root, select_brands, BrandWorkspaceAssetRef,
    BrandWorkspaceBrandBundle,
};
use crate::{now_iso, AppState};

pub(super) fn rebuild_ai_index_with_connection(
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
                if let Some(assets) = product_bundle.sku_assets.get(&sku.id) {
                    for asset in assets {
                        markdown.push_str(&format!("  - {}: {}\n", asset.role, asset.path));
                    }
                }
            }
            markdown.push('\n');
        }
        markdown.push_str("### 商品详情图\n\n");
        if product_bundle.detail_pages.is_empty() {
            markdown.push_str("- 未创建详情图版本\n\n");
        } else {
            for page in &product_bundle.detail_pages {
                let version_name = [page.market.as_str(), page.locale.as_str()]
                    .into_iter()
                    .filter(|value| !value.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" / ");
                markdown.push_str(&format!(
                    "- platformId: {}; version: {}\n",
                    page.platform,
                    if version_name.is_empty() {
                        "默认版本"
                    } else {
                        version_name.as_str()
                    }
                ));
                if let Some(assets) = product_bundle.detail_page_assets.get(&page.id) {
                    for asset in assets {
                        markdown.push_str(&format!("  - {}: {}\n", asset.role, asset.path));
                    }
                }
            }
            markdown.push('\n');
        }
    }
    markdown
}
