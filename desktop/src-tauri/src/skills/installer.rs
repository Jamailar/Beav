use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::background_command;
use crate::skills::{normalize_skill_text, split_skill_body};
use crate::slug_from_relative_path;

const SKILL_FILENAME: &str = "SKILL.md";
const INSTALL_STAGING_DIR: &str = ".install-staging";
const MAX_SCAN_DEPTH: usize = 8;
const MAX_DISCOVERED_DIRS: usize = 3000;
const MAX_SKILL_FILES: usize = 128;
const MAX_COPY_FILES: usize = 2000;
const MAX_COPY_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InstallSkillsFromRepoRequest {
    pub source: String,
    pub ref_name: Option<String>,
    pub paths: Vec<String>,
    pub scope: Option<String>,
    pub workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRepoSkill {
    pub name: String,
    pub source_path: String,
    pub path: String,
    pub replaced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillsFromRepoOutcome {
    pub source: String,
    pub ref_name: Option<String>,
    pub scope: String,
    pub install_root: String,
    pub installed: Vec<InstalledRepoSkill>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UninstallSkillRequest {
    pub name: String,
    pub scope: Option<String>,
    pub workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallSkillOutcome {
    pub name: String,
    pub scope: String,
    pub install_root: String,
    pub removed_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RepoSource {
    Git {
        url: String,
        ref_name: Option<String>,
    },
    Local {
        path: PathBuf,
    },
}

#[derive(Debug, Clone)]
struct SkillCandidate {
    name: String,
    root: PathBuf,
    skill_file: PathBuf,
}

pub fn install_skills_from_repo(
    request: InstallSkillsFromRepoRequest,
    user_skill_root: &Path,
) -> Result<InstallSkillsFromRepoOutcome, String> {
    let scope = normalized_install_scope(request.scope.as_deref())?;
    let install_root = match scope.as_str() {
        "workspace" => request
            .workspace_root
            .as_ref()
            .ok_or_else(|| "workspace scope requires workspaceRoot".to_string())?
            .join("skills"),
        "user" => user_skill_root.to_path_buf(),
        _ => unreachable!("validated scope"),
    };
    fs::create_dir_all(&install_root)
        .map_err(|err| format!("failed to create skill install root: {err}"))?;

    let source = parse_repo_source(&request.source, request.ref_name.clone())?;
    let staging_root = install_root.join(INSTALL_STAGING_DIR);
    fs::create_dir_all(&staging_root)
        .map_err(|err| format!("failed to create skill install staging root: {err}"))?;
    let staged_source = stage_repo_source(&source, &request.paths, &staging_root)?;

    let scan_roots = scan_roots_for_paths(&staged_source, &request.paths)?;
    let candidates = discover_skill_candidates(&scan_roots)?;
    if candidates.is_empty() {
        cleanup_best_effort(&staged_source, &staging_root);
        return Err("no SKILL.md files were found in the repository selection".to_string());
    }

    let mut installed = Vec::<InstalledRepoSkill>::new();
    let mut seen_names = HashSet::<String>::new();
    for candidate in candidates {
        let name_key = candidate.name.to_ascii_lowercase();
        if !seen_names.insert(name_key) {
            cleanup_best_effort(&staged_source, &staging_root);
            return Err(format!(
                "duplicate skill name `{}` found while installing repository",
                candidate.name
            ));
        }
        let target = install_root.join(slug_from_relative_path(&candidate.name));
        let replaced = install_skill_dir_atomically(&candidate.root, &target, &staging_root)?;
        installed.push(InstalledRepoSkill {
            name: candidate.name,
            source_path: candidate.skill_file.display().to_string(),
            path: target.join(SKILL_FILENAME).display().to_string(),
            replaced,
        });
    }

    cleanup_best_effort(&staged_source, &staging_root);
    Ok(InstallSkillsFromRepoOutcome {
        source: request.source,
        ref_name: source_ref_name(&source),
        scope,
        install_root: install_root.display().to_string(),
        installed,
    })
}

pub fn uninstall_skill(
    request: UninstallSkillRequest,
    user_skill_root: &Path,
) -> Result<UninstallSkillOutcome, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("skill name must not be empty".to_string());
    }
    let scope = normalized_install_scope(request.scope.as_deref())?;
    let install_root = match scope.as_str() {
        "workspace" => request
            .workspace_root
            .as_ref()
            .ok_or_else(|| "workspace scope requires workspaceRoot".to_string())?
            .join("skills"),
        "user" => user_skill_root.to_path_buf(),
        _ => unreachable!("validated scope"),
    };
    let target = install_root.join(slug_from_relative_path(name));
    validate_skill_dir_for_delete(&install_root, &target)?;
    fs::remove_dir_all(&target).map_err(|err| {
        format!(
            "failed to remove skill directory {}: {err}",
            target.display()
        )
    })?;
    Ok(UninstallSkillOutcome {
        name: name.to_string(),
        scope,
        install_root: install_root.display().to_string(),
        removed_path: target.display().to_string(),
    })
}

fn normalized_install_scope(scope: Option<&str>) -> Result<String, String> {
    match scope.unwrap_or("user").trim().to_ascii_lowercase().as_str() {
        "" | "user" | "global" => Ok("user".to_string()),
        "workspace" | "project" => Ok("workspace".to_string()),
        other => Err(format!("unsupported skill install scope `{other}`")),
    }
}

fn validate_skill_dir_for_delete(root: &Path, target: &Path) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|err| {
        format!(
            "failed to resolve skill install root {}: {err}",
            root.display()
        )
    })?;
    if !target.exists() {
        return Err(format!(
            "skill directory does not exist: {}",
            target.display()
        ));
    }
    let target = fs::canonicalize(target).map_err(|err| {
        format!(
            "failed to resolve skill directory before delete {}: {err}",
            target.display()
        )
    })?;
    if !target.starts_with(&root) || target == root {
        return Err("refusing to delete a path outside the skill install root".to_string());
    }
    if target
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value == INSTALL_STAGING_DIR)
    {
        return Err("refusing to delete the skill install staging directory".to_string());
    }
    if !target.join(SKILL_FILENAME).is_file() {
        return Err(format!(
            "refusing to delete directory without {SKILL_FILENAME}: {}",
            target.display()
        ));
    }
    Ok(())
}

fn source_ref_name(source: &RepoSource) -> Option<String> {
    match source {
        RepoSource::Git { ref_name, .. } => ref_name.clone(),
        RepoSource::Local { .. } => None,
    }
}

fn parse_repo_source(source: &str, explicit_ref: Option<String>) -> Result<RepoSource, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("repo source must not be empty".to_string());
    }
    let explicit_ref = explicit_ref
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if looks_like_local_path(source) {
        return local_repo_source(source, explicit_ref);
    }
    let (base_source, parsed_ref) = split_source_ref(source);
    let ref_name = explicit_ref.or(parsed_ref);
    if looks_like_local_path(&base_source) {
        return local_repo_source(&base_source, ref_name);
    }
    if is_git_url(&base_source) || is_ssh_git_url(&base_source) {
        return Ok(RepoSource::Git {
            url: normalize_git_url(&base_source),
            ref_name,
        });
    }
    if looks_like_github_shorthand(&base_source) {
        return Ok(RepoSource::Git {
            url: format!("https://github.com/{base_source}.git"),
            ref_name,
        });
    }
    Err(
        "invalid repository source; expected owner/repo, a git URL, or a local directory"
            .to_string(),
    )
}

fn local_repo_source(source: &str, ref_name: Option<String>) -> Result<RepoSource, String> {
    if ref_name.is_some() {
        return Err("ref is only supported for git repository sources".to_string());
    }
    let path = fs::canonicalize(source)
        .map_err(|err| format!("failed to resolve local repository source: {err}"))?;
    if !path.is_dir() {
        return Err("local repository source must be a directory".to_string());
    }
    Ok(RepoSource::Local { path })
}

fn split_source_ref(source: &str) -> (String, Option<String>) {
    if looks_like_local_path(source) {
        return (source.to_string(), None);
    }
    if let Some((base, ref_name)) = source.rsplit_once('#') {
        return (base.to_string(), non_empty_ref(ref_name));
    }
    if !source.contains("://") && !is_ssh_git_url(source) {
        if let Some((base, ref_name)) = source.rsplit_once('@') {
            return (base.to_string(), non_empty_ref(ref_name));
        }
    }
    (source.to_string(), None)
}

fn non_empty_ref(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn looks_like_local_path(source: &str) -> bool {
    let source = source.trim();
    source.starts_with('/')
        || source.starts_with('\\')
        || source.starts_with("./")
        || source.starts_with("../")
        || source.starts_with("~/")
        || is_windows_drive_absolute_path(source)
}

fn is_windows_drive_absolute_path(source: &str) -> bool {
    let bytes = source.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn is_git_url(source: &str) -> bool {
    source.starts_with("https://")
        || source.starts_with("http://")
        || source.starts_with("file://")
        || source.ends_with(".git")
}

fn is_ssh_git_url(source: &str) -> bool {
    source.starts_with("ssh://") || source.starts_with("git@") && source.contains(':')
}

fn normalize_git_url(source: &str) -> String {
    let source = source.trim_end_matches('/');
    if source.starts_with("https://github.com/") && !source.ends_with(".git") {
        format!("{source}.git")
    } else {
        source.to_string()
    }
}

fn looks_like_github_shorthand(source: &str) -> bool {
    let mut parts = source.split('/');
    let owner = parts.next();
    let repo = parts.next();
    owner.is_some_and(is_github_shorthand_segment)
        && repo.is_some_and(is_github_shorthand_segment)
        && parts.next().is_none()
}

fn is_github_shorthand_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn stage_repo_source(
    source: &RepoSource,
    paths: &[String],
    staging_root: &Path,
) -> Result<PathBuf, String> {
    match source {
        RepoSource::Local { path } => Ok(path.clone()),
        RepoSource::Git { url, ref_name } => {
            let destination = unique_staging_path(staging_root, "repo");
            if paths.is_empty() {
                run_git(
                    &["clone", url, destination.to_string_lossy().as_ref()],
                    None,
                )?;
                if let Some(ref_name) = ref_name {
                    run_git(&["checkout", ref_name], Some(&destination))?;
                }
                return Ok(destination);
            }
            run_git(
                &[
                    "clone",
                    "--filter=blob:none",
                    "--no-checkout",
                    url,
                    destination.to_string_lossy().as_ref(),
                ],
                None,
            )?;
            let normalized_paths = normalize_requested_paths(paths)?;
            let mut sparse_args = vec!["sparse-checkout", "set"];
            sparse_args.extend(normalized_paths.iter().map(String::as_str));
            run_git(&sparse_args, Some(&destination))?;
            run_git(
                &["checkout", ref_name.as_deref().unwrap_or("HEAD")],
                Some(&destination),
            )?;
            Ok(destination)
        }
    }
}

fn scan_roots_for_paths(root: &Path, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Ok(vec![root.to_path_buf()]);
    }
    normalize_requested_paths(paths)?
        .into_iter()
        .map(|relative| {
            let path = checked_join(root, &relative)?;
            if path.exists() {
                Ok(path)
            } else {
                Err(format!("requested skill path does not exist: {relative}"))
            }
        })
        .collect()
}

fn normalize_requested_paths(paths: &[String]) -> Result<Vec<String>, String> {
    let mut normalized = Vec::<String>::new();
    for path in paths {
        let trimmed = path.trim().trim_start_matches("./");
        if trimmed.is_empty() {
            continue;
        }
        let path_value = Path::new(trimmed);
        if path_value
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            return Err(format!(
                "repository path must stay inside the repository: {trimmed}"
            ));
        }
        normalized.push(trimmed.to_string());
    }
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn checked_join(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut out = base.to_path_buf();
    let path = Path::new(relative);
    for component in path.components() {
        match component {
            Component::Normal(value) => out.push(value),
            Component::CurDir => {}
            _ => return Err(format!("repository path escapes root: {relative}")),
        }
    }
    Ok(out)
}

fn discover_skill_candidates(roots: &[PathBuf]) -> Result<Vec<SkillCandidate>, String> {
    let mut candidates = Vec::<SkillCandidate>::new();
    let mut visited_dirs = 0usize;
    for root in roots {
        if root.is_file() {
            if root.file_name().and_then(|value| value.to_str()) == Some(SKILL_FILENAME) {
                candidates.push(skill_candidate_from_file(root)?);
            }
            continue;
        }
        discover_skill_candidates_in_dir(root, 0, &mut visited_dirs, &mut candidates)?;
    }
    candidates.sort_by_key(|item| item.name.to_ascii_lowercase());
    if candidates.len() > MAX_SKILL_FILES {
        return Err(format!(
            "too many SKILL.md files found: {} (max {MAX_SKILL_FILES})",
            candidates.len()
        ));
    }
    Ok(candidates)
}

fn discover_skill_candidates_in_dir(
    dir: &Path,
    depth: usize,
    visited_dirs: &mut usize,
    candidates: &mut Vec<SkillCandidate>,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    *visited_dirs += 1;
    if *visited_dirs > MAX_DISCOVERED_DIRS {
        return Err(format!(
            "repository skill scan visited too many directories (max {MAX_DISCOVERED_DIRS})"
        ));
    }
    let skill_file = dir.join(SKILL_FILENAME);
    if skill_file.is_file() {
        candidates.push(skill_candidate_from_file(&skill_file)?);
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|err| {
        format!(
            "failed to read repository directory {}: {err}",
            dir.display()
        )
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|err| format!("failed to inspect {}: {err}", path.display()))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            discover_skill_candidates_in_dir(&path, depth + 1, visited_dirs, candidates)?;
        }
    }
    Ok(())
}

fn skill_candidate_from_file(skill_file: &Path) -> Result<SkillCandidate, String> {
    let root = skill_file
        .parent()
        .ok_or_else(|| format!("skill file has no parent: {}", skill_file.display()))?
        .to_path_buf();
    let body = fs::read_to_string(skill_file)
        .map(|value| normalize_skill_text(&value))
        .map_err(|err| format!("failed to read {}: {err}", skill_file.display()))?;
    let dir_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skill")
        .trim();
    let name = parse_frontmatter_field(&body, "name")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| dir_name.to_string());
    if name.trim().is_empty() {
        return Err(format!("skill name is empty in {}", skill_file.display()));
    }
    Ok(SkillCandidate {
        name,
        root,
        skill_file: skill_file.to_path_buf(),
    })
}

fn parse_frontmatter_field(raw_body: &str, field: &str) -> Option<String> {
    let normalized = normalize_skill_text(raw_body);
    let trimmed = normalized.trim_start();
    let rest = trimmed.strip_prefix("---\n")?;
    let (frontmatter, _) = rest.split_once("\n---\n")?;
    let field = field.trim().to_ascii_lowercase();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        if raw_key.trim().to_ascii_lowercase() == field {
            let value = raw_value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn install_skill_dir_atomically(
    source: &Path,
    target: &Path,
    staging_root: &Path,
) -> Result<bool, String> {
    validate_skill_dir_for_copy(source)?;
    let tmp_target = unique_staging_path(staging_root, "skill-copy");
    copy_dir_checked(source, &tmp_target)?;
    let backup_target = unique_staging_path(staging_root, "skill-backup");
    let replaced = target.exists();
    if replaced {
        fs::rename(target, &backup_target)
            .map_err(|err| format!("failed to move existing skill aside: {err}"))?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create skill target parent: {err}"))?;
    }
    if let Err(err) = fs::rename(&tmp_target, target) {
        if replaced {
            let _ = fs::rename(&backup_target, target);
        }
        return Err(format!("failed to install skill directory: {err}"));
    }
    if replaced {
        let _ = fs::remove_dir_all(&backup_target);
    }
    Ok(replaced)
}

fn validate_skill_dir_for_copy(source: &Path) -> Result<(), String> {
    if !source.join(SKILL_FILENAME).is_file() {
        return Err(format!(
            "skill directory missing {SKILL_FILENAME}: {}",
            source.display()
        ));
    }
    let body = fs::read_to_string(source.join(SKILL_FILENAME))
        .map_err(|err| format!("failed to read skill file before install: {err}"))?;
    let (_, content) = split_skill_body(&body);
    if content.trim().is_empty() {
        return Err(format!("skill body is empty: {}", source.display()));
    }
    Ok(())
}

fn copy_dir_checked(source: &Path, target: &Path) -> Result<(), String> {
    let mut copied_files = 0usize;
    let mut copied_bytes = 0u64;
    copy_dir_checked_inner(source, target, &mut copied_files, &mut copied_bytes)
}

fn copy_dir_checked_inner(
    source: &Path,
    target: &Path,
    copied_files: &mut usize,
    copied_bytes: &mut u64,
) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|err| format!("failed to create {}: {err}", target.display()))?;
    let entries = fs::read_dir(source)
        .map_err(|err| format!("failed to read {}: {err}", source.display()))?;
    for entry in entries.flatten() {
        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|err| format!("failed to inspect {}: {err}", source_path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "skill package contains symlink: {}",
                source_path.display()
            ));
        }
        let target_path = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_dir_checked_inner(&source_path, &target_path, copied_files, copied_bytes)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        *copied_files += 1;
        if *copied_files > MAX_COPY_FILES {
            return Err(format!(
                "skill package contains too many files (max {MAX_COPY_FILES})"
            ));
        }
        *copied_bytes = copied_bytes.saturating_add(metadata.len());
        if *copied_bytes > MAX_COPY_BYTES {
            return Err(format!(
                "skill package is too large (max {} bytes)",
                MAX_COPY_BYTES
            ));
        }
        fs::copy(&source_path, &target_path).map_err(|err| {
            format!(
                "failed to copy {} to {}: {err}",
                source_path.display(),
                target_path.display()
            )
        })?;
    }
    Ok(())
}

fn unique_staging_path(root: &Path, prefix: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    root.join(format!("{prefix}-{}-{millis}", std::process::id()))
}

fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut command = background_command("git");
    command.args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|err| format!("failed to run git {}: {err}", args.join(" ")))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "git {} failed with status {}\nstdout:\n{}\nstderr:\n{}",
        args.join(" "),
        output.status,
        stdout,
        stderr
    ))
}

fn cleanup_best_effort(path: &Path, staging_root: &Path) {
    if path.starts_with(staging_root) {
        let _ = fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "redconvert-skill-installer-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn local_path_detection_accepts_windows_paths() {
        assert!(looks_like_local_path(
            r"C:\Users\Jam\AppData\Local\Temp\redbox\extracted"
        ));
        assert!(looks_like_local_path(
            "C:/Users/Jam/AppData/Local/Temp/redbox/extracted"
        ));
        assert!(looks_like_local_path(
            r"\\server\share\redbox\skills\bundle"
        ));
        assert!(looks_like_local_path(r"\Users\Jam\redbox\skills\bundle"));
        assert!(!looks_like_local_path("owner/repo"));
        assert!(!looks_like_local_path("xhs-visual-director-skill"));
    }

    #[test]
    fn local_path_ref_split_preserves_windows_user_paths() {
        let source = r"C:\Users\name@example\RedBox\skills\bundle";

        let (base, ref_name) = split_source_ref(source);

        assert_eq!(base, source);
        assert_eq!(ref_name, None);
    }

    #[test]
    fn install_skills_from_local_repo_installs_multi_skill_bundle() {
        let repo = temp_root("repo");
        let install_root = temp_root("install");
        fs::create_dir_all(repo.join("skills/alpha")).unwrap();
        fs::write(
            repo.join("skills/alpha/SKILL.md"),
            "---\nname: alpha-skill\n---\n# Alpha\n\nUse alpha.",
        )
        .unwrap();
        fs::create_dir_all(repo.join("skills/beta/references")).unwrap();
        fs::write(repo.join("skills/beta/SKILL.md"), "# Beta\n\nUse beta.").unwrap();
        fs::write(repo.join("skills/beta/references/info.md"), "info").unwrap();

        let outcome = install_skills_from_repo(
            InstallSkillsFromRepoRequest {
                source: repo.display().to_string(),
                paths: vec!["skills".to_string()],
                ..Default::default()
            },
            &install_root,
        )
        .unwrap();

        assert_eq!(outcome.installed.len(), 2);
        assert!(install_root.join("alpha-skill/SKILL.md").is_file());
        assert!(install_root.join("beta/SKILL.md").is_file());
        assert!(install_root.join("beta/references/info.md").is_file());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(install_root);
    }

    #[test]
    fn install_skills_from_repo_rejects_path_traversal() {
        let repo = temp_root("repo-traversal");
        let install_root = temp_root("install-traversal");
        let err = install_skills_from_repo(
            InstallSkillsFromRepoRequest {
                source: repo.display().to_string(),
                paths: vec!["../outside".to_string()],
                ..Default::default()
            },
            &install_root,
        )
        .unwrap_err();
        assert!(err.contains("inside the repository"));
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(install_root);
    }

    #[test]
    fn uninstall_skill_removes_managed_skill_dir() {
        let install_root = temp_root("uninstall");
        let skill_dir = install_root.join("alpha-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Alpha\n\nUse alpha.").unwrap();

        let outcome = uninstall_skill(
            UninstallSkillRequest {
                name: "alpha-skill".to_string(),
                ..Default::default()
            },
            &install_root,
        )
        .unwrap();

        assert_eq!(outcome.name, "alpha-skill");
        assert!(!skill_dir.exists());
        let _ = fs::remove_dir_all(install_root);
    }

    #[test]
    fn uninstall_skill_refuses_non_skill_dir() {
        let install_root = temp_root("uninstall-non-skill");
        let skill_dir = install_root.join("alpha-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("README.md"), "not a skill").unwrap();

        let err = uninstall_skill(
            UninstallSkillRequest {
                name: "alpha-skill".to_string(),
                ..Default::default()
            },
            &install_root,
        )
        .unwrap_err();

        assert!(err.contains("without SKILL.md"));
        assert!(skill_dir.exists());
        let _ = fs::remove_dir_all(install_root);
    }
}
