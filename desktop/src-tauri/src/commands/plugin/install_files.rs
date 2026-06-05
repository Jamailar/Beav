use super::*;

pub(super) fn copy_plugin_dir_secure(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect plugin source: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "plugin packages must not contain symlinks: {}",
                entry.path().display()
            ));
        }
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_plugin_dir_secure(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

pub(super) fn extract_plugin_archive(
    source_path: &Path,
    temp_root: &Path,
) -> Result<PathBuf, String> {
    let file = fs::File::open(source_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let extract_root = temp_root.join("extracted");
    fs::create_dir_all(&extract_root).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed_name) = file.enclosed_name().map(Path::to_path_buf) else {
            return Err(format!("archive contains an unsafe path: {}", file.name()));
        };
        let output_path = extract_root.join(enclosed_name);
        if file.name().ends_with('/') {
            fs::create_dir_all(&output_path).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = fs::File::create(&output_path).map_err(|error| error.to_string())?;
        io::copy(&mut file, &mut output).map_err(|error| error.to_string())?;
    }
    resolve_plugin_source_root(&extract_root)
}

pub(super) fn resolve_plugin_source_root(source_root: &Path) -> Result<PathBuf, String> {
    if find_thrive_plugin_manifest_path(source_root).is_some() {
        return Ok(source_root.to_path_buf());
    }
    let mut matches = Vec::new();
    for entry in fs::read_dir(source_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
            && find_thrive_plugin_manifest_path(&entry.path()).is_some()
        {
            matches.push(entry.path());
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("plugin source does not contain .redbox-plugin/plugin.json".to_string()),
        _ => Err("plugin archive contains multiple plugin roots".to_string()),
    }
}
