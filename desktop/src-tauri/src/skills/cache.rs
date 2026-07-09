use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::runtime::SkillRecord;
use crate::skills::{build_skill_package_records, read_skill_resource_value, SkillPackageRecord};

const DISCOVERY_FINGERPRINT_TTL: Duration = Duration::from_secs(2);
const MAX_CACHED_SKILL_RESOURCES: usize = 100;
const MAX_CACHED_SKILL_RESOURCE_CONTENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct SkillPerformanceCache {
    discovery: SkillDiscoveryCache,
    packages: Option<CachedSkillPackages>,
    resources: SkillResourceReadCache,
}

#[derive(Default)]
struct SkillDiscoveryCache {
    initialized: bool,
    fingerprint: String,
    checked_at: Option<Instant>,
}

#[derive(Clone)]
struct CachedSkillPackages {
    key: String,
    packages: Vec<SkillPackageRecord>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct SkillResourceReadCacheKey {
    package_hash: String,
    skill_name: String,
    raw_path: String,
    max_chars: usize,
    offset: Option<usize>,
    limit: Option<usize>,
    resolved_from: Option<String>,
}

#[derive(Default)]
struct SkillResourceReadCache {
    entries: HashMap<SkillResourceReadCacheKey, Value>,
    content_bytes: usize,
}

pub fn invalidate_skill_performance_cache(cache: &Mutex<SkillPerformanceCache>) {
    if let Ok(mut guard) = cache.lock() {
        *guard = SkillPerformanceCache::default();
    }
}

pub fn cached_discovery_fingerprint(
    cache: &Mutex<SkillPerformanceCache>,
    compute: impl FnOnce() -> String,
) -> (String, bool) {
    if let Ok(guard) = cache.lock() {
        if guard.discovery.initialized
            && guard
                .discovery
                .checked_at
                .is_some_and(|checked_at| checked_at.elapsed() < DISCOVERY_FINGERPRINT_TTL)
        {
            return (guard.discovery.fingerprint.clone(), true);
        }
    }

    let fingerprint = compute();
    if let Ok(mut guard) = cache.lock() {
        let can_skip_refresh =
            guard.discovery.initialized && guard.discovery.fingerprint == fingerprint;
        guard.discovery.initialized = true;
        guard.discovery.fingerprint = fingerprint.clone();
        guard.discovery.checked_at = Some(Instant::now());
        return (fingerprint, can_skip_refresh);
    }
    (fingerprint, false)
}

pub fn package_cache_key(
    records: &[SkillRecord],
    workspace_root: Option<&Path>,
    discovery_fingerprint: &str,
) -> String {
    let mut hasher = DefaultHasher::new();
    workspace_root
        .map(|path| path.display().to_string())
        .unwrap_or_default()
        .hash(&mut hasher);
    discovery_fingerprint.hash(&mut hasher);
    for record in records {
        record.name.hash(&mut hasher);
        record.description.hash(&mut hasher);
        record.location.hash(&mut hasher);
        record.body.hash(&mut hasher);
        record.source_scope.hash(&mut hasher);
        record.is_builtin.hash(&mut hasher);
        record.disabled.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

pub fn cached_skill_package_records(
    cache: &Mutex<SkillPerformanceCache>,
    records: &[SkillRecord],
    workspace_root: Option<&Path>,
    discovery_fingerprint: &str,
) -> Vec<SkillPackageRecord> {
    let key = package_cache_key(records, workspace_root, discovery_fingerprint);
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.packages.as_ref().filter(|cached| cached.key == key) {
            return cached.packages.clone();
        }
    }

    let packages = build_skill_package_records(records, workspace_root);
    if let Ok(mut guard) = cache.lock() {
        guard.packages = Some(CachedSkillPackages {
            key,
            packages: packages.clone(),
        });
    }
    packages
}

pub fn cached_read_skill_resource_value(
    cache: &Mutex<SkillPerformanceCache>,
    record: &SkillRecord,
    workspace_root: Option<&Path>,
    raw_path: &str,
    max_chars: usize,
    offset: Option<usize>,
    limit: Option<usize>,
    resolved_from: Option<&str>,
    package_hash: &str,
) -> Result<Value, String> {
    let key = SkillResourceReadCacheKey {
        package_hash: package_hash.to_string(),
        skill_name: record.name.clone(),
        raw_path: raw_path.to_string(),
        max_chars,
        offset,
        limit,
        resolved_from: resolved_from.map(ToString::to_string),
    };
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.resources.entries.get(&key) {
            return Ok(cached.clone());
        }
    }

    let value = read_skill_resource_value(
        record,
        workspace_root,
        raw_path,
        max_chars,
        offset,
        limit,
        resolved_from,
    )?;
    let content_bytes = value
        .get("content")
        .and_then(Value::as_str)
        .map(str::len)
        .unwrap_or(0);
    if let Ok(mut guard) = cache.lock() {
        guard.resources.insert(key, value.clone(), content_bytes);
    }
    Ok(value)
}

impl SkillResourceReadCache {
    fn insert(&mut self, key: SkillResourceReadCacheKey, value: Value, content_bytes: usize) {
        if self.entries.contains_key(&key) {
            return;
        }
        if self.entries.len() >= MAX_CACHED_SKILL_RESOURCES
            || self
                .content_bytes
                .checked_add(content_bytes)
                .is_none_or(|next| next > MAX_CACHED_SKILL_RESOURCE_CONTENT_BYTES)
        {
            self.entries.clear();
            self.content_bytes = 0;
        }
        self.content_bytes = self.content_bytes.saturating_add(content_bytes);
        self.entries.insert(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::SkillRecord;

    fn skill(name: &str, body: &str) -> SkillRecord {
        SkillRecord {
            name: name.to_string(),
            description: "desc".to_string(),
            location: format!("skills://{name}"),
            body: body.to_string(),
            source_scope: Some("user".to_string()),
            is_builtin: Some(false),
            disabled: Some(false),
        }
    }

    #[test]
    fn package_cache_key_changes_when_skill_body_changes() {
        let first = package_cache_key(&[skill("writer", "a")], None, "fp");
        let second = package_cache_key(&[skill("writer", "b")], None, "fp");
        assert_ne!(first, second);
    }

    #[test]
    fn discovery_fingerprint_cache_reuses_recent_value() {
        let cache = Mutex::new(SkillPerformanceCache::default());
        let (first, first_cached) = cached_discovery_fingerprint(&cache, || "a".to_string());
        let (second, second_cached) = cached_discovery_fingerprint(&cache, || "b".to_string());
        assert_eq!(first, "a");
        assert!(!first_cached);
        assert_eq!(second, "a");
        assert!(second_cached);
    }

    #[test]
    fn discovery_fingerprint_cache_skips_refresh_when_recomputed_value_is_unchanged() {
        let cache = Mutex::new(SkillPerformanceCache::default());
        let (_, first_cached) = cached_discovery_fingerprint(&cache, || "a".to_string());
        {
            let mut guard = cache.lock().expect("cache lock");
            guard.discovery.checked_at = None;
        }
        let (second, second_cached) = cached_discovery_fingerprint(&cache, || "a".to_string());
        assert!(!first_cached);
        assert_eq!(second, "a");
        assert!(second_cached);
    }
}
