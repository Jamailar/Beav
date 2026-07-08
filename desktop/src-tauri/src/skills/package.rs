use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::runtime::SkillRecord;
use crate::skills::{
    canonical_skill_name, load_skill_record, resolve_skill_file_path, SkillMetadataRecord,
};

const SKILL_MANIFEST_FILENAME: &str = "skill.json";
const CODEX_METADATA_PATH: &[&str] = &["agents", "openai.yaml"];
const MARKET_PROVENANCE_FILENAME: &str = ".redbox-market.json";
const RESOURCE_ROOTS_V3: &[&str] = &["references", "scripts", "assets", "rules", "templates"];
const MAX_RESOURCE_INDEX_DEPTH: usize = 8;
const MAX_RESOURCE_INDEX_FILES: usize = 512;
const MAX_RESOURCE_INDEX_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
const MAX_RESOURCE_HASH_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillManifestRuntime {
    pub allowed_runtime_modes: Vec<String>,
    pub allowed_tool_pack: Option<String>,
    pub allowed_tools: Vec<String>,
    pub blocked_tools: Vec<String>,
    pub hook_mode: Option<String>,
    pub auto_activate: bool,
    pub activation_scope: Option<String>,
    pub activation_hint: Option<String>,
    pub max_prompt_chars: Option<usize>,
    pub hidden: bool,
}

impl Default for SkillManifestRuntime {
    fn default() -> Self {
        Self {
            allowed_runtime_modes: Vec::new(),
            allowed_tool_pack: None,
            allowed_tools: Vec::new(),
            blocked_tools: Vec::new(),
            hook_mode: None,
            auto_activate: false,
            activation_scope: None,
            activation_hint: None,
            max_prompt_chars: None,
            hidden: false,
        }
    }
}

impl From<&SkillMetadataRecord> for SkillManifestRuntime {
    fn from(metadata: &SkillMetadataRecord) -> Self {
        Self {
            allowed_runtime_modes: metadata.allowed_runtime_modes.clone(),
            allowed_tool_pack: metadata.allowed_tool_pack.clone(),
            allowed_tools: metadata.allowed_tools.clone(),
            blocked_tools: metadata.blocked_tools.clone(),
            hook_mode: metadata.hook_mode.clone(),
            auto_activate: metadata.auto_activate,
            activation_scope: metadata.activation_scope.clone(),
            activation_hint: metadata.activation_hint.clone(),
            max_prompt_chars: metadata.max_prompt_chars,
            hidden: metadata.hidden,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillManifestRecord {
    pub schema_version: u32,
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<Value>,
    pub license: Option<String>,
    pub repository: Option<String>,
    pub source_url: Option<String>,
    pub tags: Vec<String>,
    pub permissions: Vec<String>,
    pub runtime: SkillManifestRuntime,
    pub interface: Option<Value>,
    pub dependencies: Option<Value>,
    pub raw: Option<Value>,
    pub codex_metadata: Option<Value>,
}

impl Default for SkillManifestRecord {
    fn default() -> Self {
        Self {
            schema_version: 1,
            name: String::new(),
            display_name: None,
            description: String::new(),
            version: None,
            author: None,
            license: None,
            repository: None,
            source_url: None,
            tags: Vec::new(),
            permissions: Vec::new(),
            runtime: SkillManifestRuntime::default(),
            interface: None,
            dependencies: None,
            raw: None,
            codex_metadata: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillResourceMeta {
    pub path: String,
    pub kind: String,
    pub byte_size: u64,
    pub sha256: Option<String>,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillAuthorityRecord {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SkillPackageProvenance {
    pub source_kind: Option<String>,
    pub market_id: Option<String>,
    pub market_name: Option<String>,
    pub package_id: Option<String>,
    pub version: Option<String>,
    pub repository: Option<String>,
    pub source_url: Option<String>,
    pub install_root: Option<String>,
    pub raw: Option<Value>,
}

impl Default for SkillPackageProvenance {
    fn default() -> Self {
        Self {
            source_kind: None,
            market_id: None,
            market_name: None,
            package_id: None,
            version: None,
            repository: None,
            source_url: None,
            install_root: None,
            raw: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidationWarning {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackageRecord {
    pub id: String,
    pub identifier: String,
    pub authority: SkillAuthorityRecord,
    pub main_resource: String,
    pub display_path: Option<String>,
    pub name: String,
    pub description: String,
    pub location: String,
    pub source_kind: String,
    pub scope: String,
    pub enabled: bool,
    pub builtin: bool,
    pub install_path: Option<String>,
    pub package_hash: String,
    pub manifest: SkillManifestRecord,
    pub resources: Vec<SkillResourceMeta>,
    pub provenance: Option<SkillPackageProvenance>,
    pub validation_warnings: Vec<SkillValidationWarning>,
}

pub fn build_skill_package_records(
    records: &[SkillRecord],
    workspace_root: Option<&Path>,
) -> Vec<SkillPackageRecord> {
    records
        .iter()
        .map(|record| build_skill_package_record(record, workspace_root))
        .collect()
}

pub fn build_skill_package_record(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
) -> SkillPackageRecord {
    let loaded = load_skill_record(record);
    let mut warnings = Vec::<SkillValidationWarning>::new();
    let skill_file = resolve_skill_file_path(record, workspace_root);
    let skill_root = skill_file
        .as_ref()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let provenance = skill_root
        .as_ref()
        .and_then(|root| load_market_provenance(root, &mut warnings));
    let source_kind = normalized_source_kind(record, provenance.as_ref(), &mut warnings);
    let scope = normalized_scope(record);
    let manifest = build_manifest(
        record,
        &loaded.metadata,
        skill_root.as_deref(),
        provenance.as_ref(),
        &mut warnings,
    );
    let resources = skill_root
        .as_ref()
        .map(|root| index_skill_resources(root, &mut warnings))
        .unwrap_or_default();

    if skill_file
        .as_ref()
        .map(|path| !path.is_file())
        .unwrap_or(true)
    {
        warnings.push(warning(
            "error",
            "MISSING_SKILL_FILE",
            format!("Skill file is missing for {}", record.name),
            skill_file.as_ref(),
        ));
    }
    if manifest.description.trim().is_empty() {
        warnings.push(warning(
            "error",
            "MISSING_DESCRIPTION",
            "Skill description is required for catalog and activation decisions.",
            skill_file.as_ref(),
        ));
    }
    if loaded.metadata.activation_hint.is_none() && !loaded.metadata.hidden {
        warnings.push(warning(
            "info",
            "MISSING_ACTIVATION_HINT",
            "Add activationHint to improve model skill selection without host-side keyword routing.",
            skill_file.as_ref(),
        ));
    }
    if resources.iter().any(|item| item.kind == "scripts")
        && loaded.metadata.allowed_tools.is_empty()
    {
        warnings.push(warning(
            "warning",
            "SCRIPT_WITHOUT_TOOL_CONTRACT",
            "Skill bundles scripts but does not declare allowedTools; add an explicit tool contract.",
            skill_file.as_ref(),
        ));
    }

    let identifier = package_identifier(record, provenance.as_ref(), &source_kind);
    let authority = skill_authority(record, provenance.as_ref(), &source_kind);
    let package_hash = package_hash(
        record,
        &manifest,
        &resources,
        provenance.as_ref(),
        &loaded.fingerprint,
    );
    let id = format!("skill_{}", short_hash(&identifier));

    SkillPackageRecord {
        id,
        identifier,
        authority,
        main_resource: "SKILL.md".to_string(),
        display_path: skill_file.as_ref().map(|path| path.display().to_string()),
        name: record.name.clone(),
        description: record.description.clone(),
        location: record.location.clone(),
        source_kind,
        scope,
        enabled: !record.disabled.unwrap_or(false),
        builtin: record.is_builtin.unwrap_or(false)
            || record.source_scope.as_deref() == Some("builtin"),
        install_path: skill_file.map(|path| path.display().to_string()),
        package_hash,
        manifest,
        resources,
        provenance,
        validation_warnings: warnings,
    }
}

pub fn enrich_skill_list_value_with_packages(list: &mut Value, packages: &[SkillPackageRecord]) {
    let package_by_name = packages
        .iter()
        .map(|package| (package.name.to_ascii_lowercase(), package))
        .collect::<HashMap<_, _>>();
    let Some(items) = list.as_array_mut() else {
        return;
    };
    for item in items {
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(package) = package_by_name.get(&name.to_ascii_lowercase()) else {
            continue;
        };
        item["identifier"] = json!(package.identifier);
        item["authority"] = json!(package.authority);
        item["skillPackage"] = json!(package.identifier);
        item["mainResource"] = json!(package.main_resource);
        item["displayPath"] = json!(package.display_path);
        item["codex"] = json!({
            "authority": package.authority,
            "package": package.identifier,
            "mainResource": package.main_resource,
            "displayPath": package.display_path,
        });
        item["sourceKind"] = json!(package.source_kind);
        item["packageHash"] = json!(package.package_hash);
        item["manifest"] = json!(package.manifest);
        item["resources"] = json!(package.resources);
        item["provenance"] = json!(package.provenance);
        item["validationWarnings"] = json!(package.validation_warnings);
        item["package"] = json!(package);
    }
}

pub fn inspect_skill_package_value(
    record: &SkillRecord,
    workspace_root: Option<&Path>,
    include_body: bool,
) -> Value {
    let package = build_skill_package_record(record, workspace_root);
    let mut value = json!({
        "success": true,
        "package": package,
    });
    if include_body {
        value["body"] = json!(record.body);
    }
    value
}

pub fn audit_skill_packages_value(records: &[SkillRecord], workspace_root: Option<&Path>) -> Value {
    let mut packages = build_skill_package_records(records, workspace_root);
    let duplicate_warnings = duplicate_name_warnings(records);
    for warning in duplicate_warnings {
        for package in packages.iter_mut().filter(|package| {
            canonical_skill_name(&package.name) == warning.path.clone().unwrap_or_default()
        }) {
            package.validation_warnings.push(warning.clone());
        }
    }

    let mut warnings = Vec::<Value>::new();
    let mut warning_count = 0usize;
    let mut error_count = 0usize;
    let mut resource_count = 0usize;
    for package in &packages {
        resource_count = resource_count.saturating_add(package.resources.len());
        for item in &package.validation_warnings {
            if item.severity == "error" {
                error_count = error_count.saturating_add(1);
            } else {
                warning_count = warning_count.saturating_add(1);
            }
            warnings.push(json!({
                "skill": package.name,
                "severity": item.severity,
                "code": item.code,
                "message": item.message,
                "path": item.path,
            }));
        }
    }

    json!({
        "success": true,
        "schemaVersion": 3,
        "packageCount": packages.len(),
        "resourceCount": resource_count,
        "warningCount": warning_count,
        "errorCount": error_count,
        "packages": packages,
        "warnings": warnings,
    })
}

fn build_manifest(
    record: &SkillRecord,
    metadata: &SkillMetadataRecord,
    skill_root: Option<&Path>,
    provenance: Option<&SkillPackageProvenance>,
    warnings: &mut Vec<SkillValidationWarning>,
) -> SkillManifestRecord {
    let mut manifest = SkillManifestRecord {
        name: record.name.clone(),
        description: record.description.clone(),
        runtime: SkillManifestRuntime::from(metadata),
        ..SkillManifestRecord::default()
    };
    if let Some(root) = skill_root {
        let manifest_path = root.join(SKILL_MANIFEST_FILENAME);
        if manifest_path.is_file() {
            match read_json_file(&manifest_path) {
                Ok(raw) => {
                    apply_manifest_json(&mut manifest, &raw);
                    manifest.raw = Some(raw);
                }
                Err(error) => warnings.push(warning(
                    "error",
                    "INVALID_SKILL_MANIFEST",
                    format!("Invalid {SKILL_MANIFEST_FILENAME}: {error}"),
                    Some(&manifest_path),
                )),
            }
        } else {
            warnings.push(warning(
                "info",
                "LEGACY_SKILL_MANIFEST",
                "No skill.json manifest found; using legacy SKILL.md/frontmatter metadata.",
                Some(&manifest_path),
            ));
        }

        let codex_metadata_path = CODEX_METADATA_PATH
            .iter()
            .fold(root.to_path_buf(), |path, segment| path.join(segment));
        if codex_metadata_path.is_file() {
            match read_yaml_as_json(&codex_metadata_path) {
                Ok(raw) => {
                    if manifest.interface.is_none() {
                        manifest.interface = raw.get("interface").cloned();
                    }
                    if manifest.dependencies.is_none() {
                        manifest.dependencies = raw.get("dependencies").cloned();
                    }
                    manifest.codex_metadata = Some(raw);
                }
                Err(error) => warnings.push(warning(
                    "warning",
                    "INVALID_CODEX_METADATA",
                    format!("Invalid agents/openai.yaml: {error}"),
                    Some(&codex_metadata_path),
                )),
            }
        }
    }

    if manifest.version.is_none() {
        manifest.version = provenance.and_then(|item| item.version.clone());
    }
    if manifest.repository.is_none() {
        manifest.repository = provenance.and_then(|item| item.repository.clone());
    }
    if manifest.source_url.is_none() {
        manifest.source_url = provenance.and_then(|item| item.source_url.clone());
    }
    manifest.name = non_empty(&manifest.name).unwrap_or_else(|| record.name.clone());
    manifest.description =
        non_empty(&manifest.description).unwrap_or_else(|| record.description.clone());
    manifest.tags = normalized_string_list(manifest.tags);
    manifest.permissions = normalized_string_list(manifest.permissions);
    manifest
}

fn apply_manifest_json(manifest: &mut SkillManifestRecord, raw: &Value) {
    manifest.schema_version = raw
        .get("schemaVersion")
        .or_else(|| raw.get("schema_version"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(manifest.schema_version);
    if let Some(value) = json_string(raw, &["name"]) {
        manifest.name = value;
    }
    manifest.display_name = json_string(raw, &["displayName", "display_name", "title"])
        .or_else(|| manifest.display_name.clone());
    if let Some(value) = json_string(raw, &["description"]) {
        manifest.description = value;
    }
    manifest.version = json_string(raw, &["version"]).or_else(|| manifest.version.clone());
    manifest.author = raw
        .get("author")
        .cloned()
        .or_else(|| manifest.author.clone());
    manifest.license = json_string(raw, &["license"]).or_else(|| manifest.license.clone());
    manifest.repository =
        json_string(raw, &["repository", "repo"]).or_else(|| manifest.repository.clone());
    manifest.source_url =
        json_string(raw, &["sourceUrl", "source_url"]).or_else(|| manifest.source_url.clone());
    let tags = json_string_list(raw.get("tags"));
    if !tags.is_empty() {
        manifest.tags = tags;
    }
    let permissions = json_string_list(raw.get("permissions"));
    if !permissions.is_empty() {
        manifest.permissions = permissions;
    }
    manifest.interface = raw
        .get("interface")
        .cloned()
        .or_else(|| manifest.interface.clone());
    manifest.dependencies = raw
        .get("dependencies")
        .cloned()
        .or_else(|| manifest.dependencies.clone());
}

fn index_skill_resources(
    skill_root: &Path,
    warnings: &mut Vec<SkillValidationWarning>,
) -> Vec<SkillResourceMeta> {
    let canonical_root = match skill_root.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            warnings.push(warning(
                "warning",
                "SKILL_ROOT_UNRESOLVED",
                format!("Failed to resolve skill root: {error}"),
                Some(skill_root),
            ));
            return Vec::new();
        }
    };
    let mut resources = Vec::<SkillResourceMeta>::new();
    let mut total_bytes = 0u64;
    for root_name in RESOURCE_ROOTS_V3 {
        let dir = canonical_root.join(root_name);
        if dir.is_dir() {
            collect_resources(
                &canonical_root,
                &dir,
                0,
                &mut resources,
                &mut total_bytes,
                warnings,
            );
        }
    }
    resources.sort_by(|left, right| left.path.cmp(&right.path));
    resources
}

fn collect_resources(
    skill_root: &Path,
    dir: &Path,
    depth: usize,
    resources: &mut Vec<SkillResourceMeta>,
    total_bytes: &mut u64,
    warnings: &mut Vec<SkillValidationWarning>,
) {
    if depth > MAX_RESOURCE_INDEX_DEPTH || resources.len() >= MAX_RESOURCE_INDEX_FILES {
        warnings.push(warning(
            "warning",
            "RESOURCE_INDEX_TRUNCATED",
            "Skill resource index was truncated by depth or file count limit.",
            Some(dir),
        ));
        return;
    }
    let mut entries = match fs::read_dir(dir) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(error) => {
            warnings.push(warning(
                "warning",
                "RESOURCE_DIR_READ_FAILED",
                format!("Failed to read resource directory: {error}"),
                Some(dir),
            ));
            return;
        }
    };
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        if resources.len() >= MAX_RESOURCE_INDEX_FILES {
            warnings.push(warning(
                "warning",
                "RESOURCE_INDEX_TRUNCATED",
                "Skill resource index was truncated by file count limit.",
                Some(dir),
            ));
            return;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(warning(
                    "warning",
                    "RESOURCE_STAT_FAILED",
                    format!("Failed to stat resource: {error}"),
                    Some(&path),
                ));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            warnings.push(warning(
                "warning",
                "RESOURCE_SYMLINK_SKIPPED",
                "Skill resource symlink was skipped.",
                Some(&path),
            ));
            continue;
        }
        if metadata.is_dir() {
            collect_resources(
                skill_root,
                &path,
                depth + 1,
                resources,
                total_bytes,
                warnings,
            );
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if total_bytes.saturating_add(metadata.len()) > MAX_RESOURCE_INDEX_TOTAL_BYTES {
            warnings.push(warning(
                "warning",
                "RESOURCE_INDEX_BYTE_LIMIT",
                "Skill resource index reached total byte limit.",
                Some(&path),
            ));
            continue;
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        let Some(relative) = relative_resource_path(skill_root, &path) else {
            warnings.push(warning(
                "warning",
                "RESOURCE_PATH_UNRESOLVED",
                "Failed to resolve resource path relative to skill root.",
                Some(&path),
            ));
            continue;
        };
        let sha256 = if metadata.len() <= MAX_RESOURCE_HASH_BYTES {
            fs::read(&path)
                .ok()
                .map(|bytes| format!("{:x}", Sha256::digest(&bytes)))
        } else {
            warnings.push(warning(
                "info",
                "RESOURCE_HASH_SKIPPED",
                "Resource hash skipped because the file is large.",
                Some(&path),
            ));
            None
        };
        resources.push(SkillResourceMeta {
            kind: resource_kind(&relative).to_string(),
            path: relative,
            byte_size: metadata.len(),
            sha256,
            modified_at: modified_millis(&metadata),
        });
    }
}

fn load_market_provenance(
    skill_root: &Path,
    warnings: &mut Vec<SkillValidationWarning>,
) -> Option<SkillPackageProvenance> {
    let path = skill_root.join(MARKET_PROVENANCE_FILENAME);
    if !path.is_file() {
        return None;
    }
    let raw = match read_json_file(&path) {
        Ok(raw) => raw,
        Err(error) => {
            warnings.push(warning(
                "warning",
                "INVALID_MARKET_PROVENANCE",
                format!("Invalid market provenance: {error}"),
                Some(&path),
            ));
            return None;
        }
    };
    Some(SkillPackageProvenance {
        source_kind: json_string(&raw, &["sourceKind", "source_kind", "source"]),
        market_id: json_string(&raw, &["marketId", "market_id"]),
        market_name: json_string(&raw, &["marketName", "market_name"]),
        package_id: json_string(&raw, &["packageId", "package_id", "id"]),
        version: json_string(&raw, &["marketVersion", "version"]),
        repository: json_string(&raw, &["repo", "repository"]),
        source_url: json_string(&raw, &["sourceUrl", "source_url", "url"]),
        install_root: json_string(&raw, &["installRoot", "install_root"]),
        raw: Some(raw),
    })
}

fn normalized_source_kind(
    record: &SkillRecord,
    provenance: Option<&SkillPackageProvenance>,
    warnings: &mut Vec<SkillValidationWarning>,
) -> String {
    let raw = provenance
        .and_then(|item| item.source_kind.as_deref())
        .or(record.source_scope.as_deref())
        .unwrap_or("user");
    let normalized = raw.trim().to_ascii_lowercase().replace('_', "-");
    if normalized.contains("lobehub") {
        warnings.push(warning(
            "error",
            "INVALID_LOBEHUB_SOURCE",
            "LobeHub may be used as reference only; keep package source mapped to the original upstream such as github or redskill.",
            None::<&Path>,
        ));
        return "community".to_string();
    }
    match normalized.as_str() {
        "builtin" | "system" => "builtin",
        "workspace" | "repo" | "project" => "workspace",
        "market" | "marketplace" => "market",
        "redskill" | "redskill-cli" => "redskill",
        "direct-repo" | "github" | "github-repo" => "github",
        "redbox-server" | "official" => "official",
        "legacy-thrive" | "thrive-community" => "legacy",
        "user" | "local" | "" => "user",
        other => other,
    }
    .to_string()
}

fn normalized_scope(record: &SkillRecord) -> String {
    match record.source_scope.as_deref().unwrap_or("user") {
        "builtin" => "system",
        "workspace" => "workspace",
        "user" | "market" => "user",
        other => other,
    }
    .to_string()
}

fn skill_authority(
    record: &SkillRecord,
    provenance: Option<&SkillPackageProvenance>,
    source_kind: &str,
) -> SkillAuthorityRecord {
    let kind = if record.is_builtin.unwrap_or(false)
        || record.source_scope.as_deref() == Some("builtin")
        || matches!(
            source_kind,
            "builtin" | "official" | "user" | "workspace" | "github" | "market" | "redskill"
        ) {
        "host"
    } else {
        "custom"
    };
    let id = provenance
        .and_then(|item| item.market_id.as_deref())
        .and_then(non_empty)
        .unwrap_or_else(|| source_kind.to_string());
    SkillAuthorityRecord {
        kind: kind.to_string(),
        id,
    }
}

fn duplicate_name_warnings(records: &[SkillRecord]) -> Vec<SkillValidationWarning> {
    let mut counts = BTreeMap::<String, usize>::new();
    for record in records {
        *counts
            .entry(canonical_skill_name(&record.name))
            .or_default() += 1;
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(name, count)| SkillValidationWarning {
            severity: "error".to_string(),
            code: "DUPLICATE_SKILL_NAME".to_string(),
            message: format!("Skill name `{name}` appears {count} times; names must be unique after normalization."),
            path: Some(name),
        })
        .collect()
}

fn package_identifier(
    record: &SkillRecord,
    provenance: Option<&SkillPackageProvenance>,
    source_kind: &str,
) -> String {
    if let Some(package_id) = provenance
        .and_then(|item| item.package_id.as_deref())
        .and_then(non_empty)
    {
        return format!("{source_kind}:{package_id}");
    }
    if let Some(market_id) = provenance
        .and_then(|item| item.market_id.as_deref())
        .and_then(non_empty)
    {
        return format!("{source_kind}:{market_id}:{}", record.name);
    }
    format!("{source_kind}:{}", record.name)
}

fn package_hash(
    record: &SkillRecord,
    manifest: &SkillManifestRecord,
    resources: &[SkillResourceMeta],
    provenance: Option<&SkillPackageProvenance>,
    loaded_fingerprint: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(record.name.as_bytes());
    hasher.update(record.location.as_bytes());
    hasher.update(loaded_fingerprint.as_bytes());
    if let Ok(raw) = serde_json::to_vec(manifest) {
        hasher.update(raw);
    }
    if let Some(provenance) = provenance.and_then(|item| item.raw.as_ref()) {
        if let Ok(raw) = serde_json::to_vec(provenance) {
            hasher.update(raw);
        }
    }
    for resource in resources {
        hasher.update(resource.path.as_bytes());
        hasher.update(resource.byte_size.to_le_bytes());
        if let Some(sha256) = &resource.sha256 {
            hasher.update(sha256.as_bytes());
        }
    }
    format!("{:x}", hasher.finalize())
}

fn short_hash(value: &str) -> String {
    let hash = Sha256::digest(value.as_bytes());
    format!("{:x}", hash)[..16].to_string()
}

fn relative_resource_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::<String>::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn resource_kind(path: &str) -> &str {
    path.split('/').next().unwrap_or("resource")
}

fn modified_millis(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn read_yaml_as_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&raw).map_err(|error| error.to_string())?;
    serde_json::to_value(yaml).map_err(|error| error.to_string())
}

fn json_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .filter_map(Value::as_str)
        .find_map(non_empty)
}

fn json_string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter_map(non_empty)
            .collect(),
        Some(Value::String(value)) => value.split(',').filter_map(non_empty).collect(),
        _ => Vec::new(),
    }
}

fn normalized_string_list(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    items
        .into_iter()
        .filter_map(|item| non_empty(&item))
        .filter(|item| seen.insert(item.to_ascii_lowercase()))
        .collect()
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn warning(
    severity: impl Into<String>,
    code: impl Into<String>,
    message: impl Into<String>,
    path: Option<impl AsRef<Path>>,
) -> SkillValidationWarning {
    SkillValidationWarning {
        severity: severity.into(),
        code: code.into(),
        message: message.into(),
        path: path.map(|item| item.as_ref().display().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "redbox-skill-package-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    fn workspace_record(name: &str) -> SkillRecord {
        SkillRecord {
            name: name.to_string(),
            description: "Writer skill".to_string(),
            location: format!("skills://{name}"),
            body:
                "---\nactivationHint: when writing\nallowedTools: [bash]\n---\n# Skill\n\nUse this."
                    .to_string(),
            source_scope: Some("workspace".to_string()),
            is_builtin: Some(false),
            disabled: Some(false),
        }
    }

    #[test]
    fn package_record_reads_manifest_and_resources() {
        let root = temp_root("manifest");
        let skill_dir = root.join("skills").join("writer");
        fs::create_dir_all(skill_dir.join("references")).expect("create references");
        fs::write(skill_dir.join("SKILL.md"), "# Writer").expect("write skill");
        fs::write(
            skill_dir.join("skill.json"),
            r#"{"name":"writer","description":"Manifest desc","version":"1.2.3","tags":["copy"]}"#,
        )
        .expect("write manifest");
        fs::write(skill_dir.join("references").join("guide.md"), "hello").expect("write ref");

        let package = build_skill_package_record(&workspace_record("writer"), Some(&root));
        assert_eq!(package.manifest.description, "Manifest desc");
        assert_eq!(package.manifest.version.as_deref(), Some("1.2.3"));
        assert_eq!(package.resources.len(), 1);
        assert_eq!(package.resources[0].path, "references/guide.md");
        assert_eq!(package.source_kind, "workspace");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn audit_flags_lobehub_source_metadata() {
        let root = temp_root("lobehub");
        let skill_dir = root.join("skills").join("writer");
        fs::create_dir_all(&skill_dir).expect("create skill");
        fs::write(skill_dir.join("SKILL.md"), "# Writer").expect("write skill");
        fs::write(
            skill_dir.join(".redbox-market.json"),
            r#"{"sourceKind":"lobehub","packageId":"writer"}"#,
        )
        .expect("write provenance");
        let package = build_skill_package_record(&workspace_record("writer"), Some(&root));
        assert_eq!(package.source_kind, "community");
        assert!(package
            .validation_warnings
            .iter()
            .any(|warning| warning.code == "INVALID_LOBEHUB_SOURCE"));
        let _ = fs::remove_dir_all(root);
    }
}
