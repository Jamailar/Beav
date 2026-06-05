use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::fs;
use tauri::State;

use super::{brand_workspace_asset_root, AssetMutationInput};
use crate::http_utils::decode_base64_bytes;
use crate::{make_id, now_iso, AppState};

pub(super) fn sync_asset_images(
    conn: &Connection,
    state: &State<'_, AppState>,
    owner_type: &str,
    owner_id: &str,
    images: Vec<AssetMutationInput>,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM asset_refs WHERE owner_type = ?1 AND owner_id = ?2 AND role = 'image'",
        params![owner_type, owner_id],
    )
    .map_err(|error| error.to_string())?;
    let now = now_iso();
    let mut used_ids = HashSet::new();
    for (index, image) in images.into_iter().enumerate() {
        let path = if let Some(data_url) = image
            .data_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            write_asset_data_url(state, owner_type, owner_id, data_url, image.name.as_deref())?
        } else {
            image
                .path
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "图片缺少路径".to_string())?
        };
        let id = unique_asset_ref_id(conn, image.id, index, &mut used_ids)?;
        conn.execute(
            "INSERT INTO asset_refs (
                id, owner_type, owner_id, path, role, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                owner_type,
                owner_id,
                path,
                image.role.unwrap_or_else(|| "image".to_string()),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn data_url_extension(meta: &str) -> &'static str {
    let mime = meta
        .strip_prefix("data:")
        .unwrap_or(meta)
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

fn write_asset_data_url(
    state: &State<'_, AppState>,
    owner_type: &str,
    owner_id: &str,
    data_url: &str,
    name: Option<&str>,
) -> Result<String, String> {
    let (meta, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "图片 data URL 无效".to_string())?;
    if !meta
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return Err("图片 data URL 必须是 base64".to_string());
    }
    let bytes = decode_base64_bytes(encoded)?;
    let extension = name
        .and_then(|value| value.rsplit_once('.').map(|(_, ext)| ext))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg"
            )
        })
        .unwrap_or_else(|| data_url_extension(meta).to_string());
    let dir = brand_workspace_asset_root(state)?
        .join(owner_type)
        .join(owner_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let timestamp = now_iso().replace(':', "-").replace('.', "-");
    let file_name = format!("image-{}-{}.{}", timestamp, make_id("asset"), extension);
    let path = dir.join(file_name);
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn asset_ref_id_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM asset_refs WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(existing.is_some())
}

fn unique_asset_ref_id(
    conn: &Connection,
    requested_id: Option<String>,
    index: usize,
    used_ids: &mut HashSet<String>,
) -> Result<String, String> {
    if let Some(id) = requested_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !used_ids.contains(&id) && !asset_ref_id_exists(conn, &id)? {
            used_ids.insert(id.clone());
            return Ok(id);
        }
    }

    let base = make_id("asset");
    let mut suffix = index;
    loop {
        let id = format!("{base}-{suffix}");
        if !used_ids.contains(&id) && !asset_ref_id_exists(conn, &id)? {
            used_ids.insert(id.clone());
            return Ok(id);
        }
        suffix += 1;
    }
}
