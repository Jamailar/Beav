use super::*;

fn normalize_plugin_skill_name(plugin_name: &str, skill_name: &str) -> String {
    let prefix = format!("{plugin_name}:");
    if skill_name.starts_with(&prefix) {
        skill_name.to_string()
    } else {
        format!("{prefix}{skill_name}")
    }
}

pub(super) fn enabled_thrive_plugin_entries(
    state: &State<'_, AppState>,
) -> Result<Vec<(String, ThrivePluginIndexEntry, RawThrivePluginManifest)>, String> {
    let index = load_thrive_plugin_index(state)?;
    let mut plugins = Vec::new();
    for (plugin_id, entry) in index.plugins {
        if !entry.enabled {
            continue;
        }
        let root = PathBuf::from(&entry.root);
        let manifest = load_thrive_plugin_manifest(&root)?;
        plugins.push((plugin_id, entry, manifest));
    }
    Ok(plugins)
}

fn discover_thrive_plugin_skill_records(
    plugin_id: &str,
    entry: &ThrivePluginIndexEntry,
    manifest: &RawThrivePluginManifest,
) -> Vec<SkillRecord> {
    let root = PathBuf::from(&entry.root);
    let Some(skills_root) =
        validate_manifest_relative_path(&root, "skills", manifest.skills.as_deref())
            .ok()
            .flatten()
            .or_else(|| {
                let default_root = root.join("skills");
                default_root.is_dir().then_some(default_root)
            })
    else {
        return Vec::new();
    };
    discover_skill_records_from_root(&skills_root, &thrive_plugin_source_scope(plugin_id), false)
        .into_iter()
        .map(|mut record| {
            record.name = normalize_plugin_skill_name(&manifest.name, &record.name);
            record.location = format!(
                "thrive://plugins/{}/skills/{}",
                plugin_id,
                slug_from_relative_path(&record.name)
            );
            record.source_scope = Some(thrive_plugin_source_scope(plugin_id));
            record.is_builtin = Some(false);
            record.disabled = Some(false);
            record
        })
        .collect()
}

const CODEX_PLUGIN_DEFAULT_HOOKS_CONFIG_FILE: &str = "hooks/hooks.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CodexPluginHooksFile {
    #[serde(default)]
    hooks: CodexPluginHookEvents,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CodexPluginHookEvents {
    #[serde(rename = "PreToolUse", default)]
    pre_tool_use: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "PermissionRequest", default)]
    permission_request: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "PostToolUse", default)]
    post_tool_use: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "PreCompact", default)]
    pre_compact: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "PostCompact", default)]
    post_compact: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "SessionStart", default)]
    session_start: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "UserPromptSubmit", default)]
    user_prompt_submit: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "SubagentStart", default)]
    subagent_start: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "SubagentStop", default)]
    subagent_stop: Vec<CodexPluginHookMatcherGroup>,
    #[serde(rename = "Stop", default)]
    stop: Vec<CodexPluginHookMatcherGroup>,
}

impl CodexPluginHookEvents {
    fn is_empty(&self) -> bool {
        self.event_groups()
            .into_iter()
            .all(|(_, groups)| groups.is_empty())
    }

    fn event_groups(&self) -> [(&'static str, &Vec<CodexPluginHookMatcherGroup>); 10] {
        [
            ("PreToolUse", &self.pre_tool_use),
            ("PermissionRequest", &self.permission_request),
            ("PostToolUse", &self.post_tool_use),
            ("PreCompact", &self.pre_compact),
            ("PostCompact", &self.post_compact),
            ("SessionStart", &self.session_start),
            ("UserPromptSubmit", &self.user_prompt_submit),
            ("SubagentStart", &self.subagent_start),
            ("SubagentStop", &self.subagent_stop),
            ("Stop", &self.stop),
        ]
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CodexPluginHookMatcherGroup {
    #[serde(default)]
    matcher: Option<String>,
    #[serde(default)]
    hooks: Vec<CodexPluginHookHandler>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum CodexPluginHookHandler {
    #[serde(rename = "command")]
    Command {
        command: String,
        #[serde(default, rename = "commandWindows", alias = "command_windows")]
        command_windows: Option<String>,
        #[serde(default, rename = "timeout")]
        timeout_sec: Option<u64>,
        #[serde(default)]
        r#async: bool,
        #[serde(default, rename = "statusMessage")]
        status_message: Option<String>,
    },
    #[serde(rename = "prompt")]
    Prompt {},
    #[serde(rename = "agent")]
    Agent {},
}

fn plugin_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn codex_plugin_hook_file_to_records(
    plugin_id: &str,
    plugin_root: &Path,
    plugin_data_root: Option<&Path>,
    source_path: &Path,
    source_relative_path: &str,
    hooks_file: CodexPluginHooksFile,
) -> Vec<RuntimeHookRecord> {
    if hooks_file.hooks.is_empty() {
        return Vec::new();
    }
    let source_scope = thrive_plugin_source_scope(plugin_id);
    let source_slug = slug_from_relative_path(source_relative_path);
    hooks_file
        .hooks
        .event_groups()
        .into_iter()
        .flat_map(|(event, groups)| {
            groups.iter().enumerate().flat_map({
                let source_scope = source_scope.clone();
                let plugin_root = plugin_root.display().to_string();
                let plugin_data_root = plugin_data_root.map(|path| path.display().to_string());
                let source_path = source_path.display().to_string();
                let source_relative_path = source_relative_path.to_string();
                let source_slug = source_slug.clone();
                move |(group_index, group)| {
                    let source_scope = source_scope.clone();
                    let plugin_root = plugin_root.clone();
                    let plugin_data_root = plugin_data_root.clone();
                    let source_path = source_path.clone();
                    let source_relative_path = source_relative_path.clone();
                    let source_slug = source_slug.clone();
                    group
                        .hooks
                        .iter()
                        .enumerate()
                        .map(move |(handler_index, handler)| {
                            let (
                                hook_type,
                                command,
                                command_windows,
                                timeout_sec,
                                r#async,
                                status_message,
                            ) = match handler {
                                CodexPluginHookHandler::Command {
                                    command,
                                    command_windows,
                                    timeout_sec,
                                    r#async,
                                    status_message,
                                } => (
                                    "command",
                                    Some(command.clone()),
                                    command_windows.clone(),
                                    *timeout_sec,
                                    Some(*r#async),
                                    status_message.clone(),
                                ),
                                CodexPluginHookHandler::Prompt {} => {
                                    ("prompt", None, None, None, None, None)
                                }
                                CodexPluginHookHandler::Agent {} => {
                                    ("agent", None, None, None, None, None)
                                }
                            };
                            RuntimeHookRecord {
                                id: format!(
                                    "plugin:{plugin_id}:hook:{source_slug}:{event}:{group_index}:{handler_index}"
                                ),
                                event: event.to_string(),
                                r#type: hook_type.to_string(),
                                matcher: group.matcher.clone(),
                                enabled: Some(true),
                                source_scope: Some(source_scope.clone()),
                                plugin_id: Some(plugin_id.to_string()),
                                plugin_root: Some(plugin_root.clone()),
                                plugin_data_root: plugin_data_root.clone(),
                                source_path: Some(source_path.clone()),
                                source_relative_path: Some(source_relative_path.clone()),
                                command,
                                command_windows,
                                timeout_sec,
                                r#async,
                                status_message,
                                raw: serde_json::to_value(handler).ok(),
                            }
                        })
                }
            })
        })
        .collect()
}

fn read_codex_plugin_hooks_file(
    plugin_id: &str,
    root: &Path,
    plugin_data_root: Option<&Path>,
    hooks_path: &Path,
) -> Vec<RuntimeHookRecord> {
    let Ok(raw) = fs::read_to_string(hooks_path) else {
        return Vec::new();
    };
    let Ok(hooks_file) = serde_json::from_str::<CodexPluginHooksFile>(&raw) else {
        return Vec::new();
    };
    codex_plugin_hook_file_to_records(
        plugin_id,
        root,
        plugin_data_root,
        hooks_path,
        &plugin_relative_path(root, hooks_path),
        hooks_file,
    )
}

fn discover_thrive_plugin_hooks(
    plugin_id: &str,
    entry: &ThrivePluginIndexEntry,
    manifest: &RawThrivePluginManifest,
    plugin_data_root: Option<&Path>,
) -> Vec<RuntimeHookRecord> {
    let root = PathBuf::from(&entry.root);
    let Some(hooks) = manifest.hooks.as_ref() else {
        let default_path = root.join(CODEX_PLUGIN_DEFAULT_HOOKS_CONFIG_FILE);
        return default_path
            .is_file()
            .then(|| {
                read_codex_plugin_hooks_file(plugin_id, &root, plugin_data_root, &default_path)
            })
            .unwrap_or_default();
    };

    if let Some(path) = hooks.as_str() {
        return validate_manifest_relative_path(&root, "hooks", Some(path))
            .ok()
            .flatten()
            .map(|path| read_codex_plugin_hooks_file(plugin_id, &root, plugin_data_root, &path))
            .unwrap_or_default();
    }
    if let Some(paths) = hooks
        .as_array()
        .and_then(|items| items.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
    {
        return paths
            .into_iter()
            .flat_map(|path| {
                validate_manifest_relative_path(&root, "hooks", Some(path))
                    .ok()
                    .flatten()
                    .map(|path| {
                        read_codex_plugin_hooks_file(plugin_id, &root, plugin_data_root, &path)
                    })
                    .unwrap_or_default()
            })
            .collect();
    }
    if hooks.is_object() {
        return serde_json::from_value::<CodexPluginHooksFile>(hooks.clone())
            .ok()
            .map(|hooks_file| {
                let manifest_path = find_thrive_plugin_manifest_path(&root)
                    .unwrap_or_else(|| root.join("plugin.json"));
                codex_plugin_hook_file_to_records(
                    plugin_id,
                    &root,
                    plugin_data_root,
                    &manifest_path,
                    "plugin.json#hooks[0]",
                    hooks_file,
                )
            })
            .unwrap_or_default();
    }
    hooks
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .flat_map(|(index, hooks_value)| {
            let Ok(hooks_file) =
                serde_json::from_value::<CodexPluginHooksFile>(hooks_value.clone())
            else {
                return Vec::new();
            };
            let manifest_path =
                find_thrive_plugin_manifest_path(&root).unwrap_or_else(|| root.join("plugin.json"));
            codex_plugin_hook_file_to_records(
                plugin_id,
                &root,
                plugin_data_root,
                &manifest_path,
                &format!("plugin.json#hooks[{index}]"),
                hooks_file,
            )
        })
        .collect()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginMcpServersFile {
    #[serde(default)]
    mcp_servers: BTreeMap<String, Value>,
}

fn parse_plugin_mcp_servers_file(value: Value) -> BTreeMap<String, Value> {
    if value
        .as_object()
        .is_some_and(|object| object.contains_key("mcpServers"))
    {
        if let Ok(file) = serde_json::from_value::<PluginMcpServersFile>(value.clone()) {
            return file.mcp_servers;
        }
    }
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter(|(key, value)| !key.starts_with('$') && value.is_object())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default()
}

fn resolve_plugin_runtime_path(root: &Path, value: &str) -> String {
    value
        .strip_prefix("./")
        .map(|relative| root.join(relative).display().to_string())
        .unwrap_or_else(|| value.to_string())
}

fn resolve_plugin_cwd(root: &Path, value: Option<&str>) -> Option<String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty())?;
    let path = Path::new(value);
    if path.is_absolute() {
        return Some(value.to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(root.join(path).display().to_string())
}

fn plugin_mcp_transport(object: &serde_json::Map<String, Value>) -> String {
    let raw_type = object
        .get("type")
        .or_else(|| object.get("transport"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    match raw_type.as_deref() {
        Some("sse") => "sse".to_string(),
        Some("http") | Some("streamable_http") | Some("streamable-http") => {
            "streamable-http".to_string()
        }
        Some("stdio") => "stdio".to_string(),
        _ if object.get("url").is_some() => "streamable-http".to_string(),
        _ => "stdio".to_string(),
    }
}

fn plugin_mcp_string_array(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<Vec<String>> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
}

fn plugin_mcp_env(
    object: &serde_json::Map<String, Value>,
) -> Option<std::collections::HashMap<String, String>> {
    object
        .get("env")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect::<std::collections::HashMap<_, _>>()
        })
        .filter(|items| !items.is_empty())
}

fn normalize_plugin_mcp_oauth(object: &serde_json::Map<String, Value>) -> Value {
    let mut oauth_value = object.get("oauth").cloned().unwrap_or_else(|| json!({}));
    if !oauth_value.is_object() {
        oauth_value = json!({});
    }
    if let Some(oauth) = oauth_value.as_object_mut() {
        if let Some(client_id) = oauth.remove("clientId") {
            oauth.entry("client_id".to_string()).or_insert(client_id);
        }
        oauth.remove("callbackPort");
    }
    oauth_value
}

fn plugin_mcp_env_vars(object: &serde_json::Map<String, Value>) -> Vec<Value> {
    object
        .get("env_vars")
        .or_else(|| object.get("envVars"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    if item.as_str().is_some() || item.is_object() {
                        Some(item.clone())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn copy_plugin_mcp_policy_field(
    source: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(source_key) {
        target.insert(target_key.to_string(), value.clone());
    }
}

fn plugin_mcp_runtime_metadata(
    plugin_id: &str,
    plugin_name: &str,
    object: &serde_json::Map<String, Value>,
) -> Value {
    let mut oauth_value = normalize_plugin_mcp_oauth(object);
    let Some(oauth_object) = oauth_value.as_object_mut() else {
        return json!({});
    };
    let redbox = oauth_object.entry("redbox").or_insert_with(|| json!({}));
    if !redbox.is_object() {
        *redbox = json!({});
    }
    let redbox_object = redbox.as_object_mut().expect("redbox metadata object");
    redbox_object.insert("pluginId".to_string(), json!(plugin_id));
    redbox_object.insert("pluginName".to_string(), json!(plugin_name));
    let env_vars = plugin_mcp_env_vars(object);
    if !env_vars.is_empty() {
        redbox_object.insert("envVars".to_string(), Value::Array(env_vars));
    }
    for (source_key, target_key) in [
        ("bearer_token_env_var", "bearerTokenEnvVar"),
        ("bearerTokenEnvVar", "bearerTokenEnvVar"),
        ("required", "required"),
        ("startup_timeout_sec", "startupTimeoutSec"),
        ("startupTimeoutSec", "startupTimeoutSec"),
        ("startupTimeoutMs", "startupTimeoutMs"),
        ("tool_timeout_sec", "toolTimeoutSec"),
        ("toolTimeoutSec", "toolTimeoutSec"),
        ("toolTimeoutMs", "toolTimeoutMs"),
        ("supports_parallel_tool_calls", "supportsParallelToolCalls"),
        ("supportsParallelToolCalls", "supportsParallelToolCalls"),
        ("default_tools_approval_mode", "defaultToolsApprovalMode"),
        ("defaultToolsApprovalMode", "defaultToolsApprovalMode"),
        ("enabled_tools", "enabledTools"),
        ("enabledTools", "enabledTools"),
        ("disabled_tools", "disabledTools"),
        ("disabledTools", "disabledTools"),
        ("tools", "tools"),
        ("http_headers", "httpHeaders"),
        ("httpHeaders", "httpHeaders"),
        ("env_http_headers", "envHttpHeaders"),
        ("envHttpHeaders", "envHttpHeaders"),
    ] {
        copy_plugin_mcp_policy_field(object, redbox_object, source_key, target_key);
    }
    oauth_value
}

fn discover_thrive_plugin_mcp_servers(
    plugin_id: &str,
    entry: &ThrivePluginIndexEntry,
    manifest: &RawThrivePluginManifest,
) -> Vec<McpServerRecord> {
    let root = PathBuf::from(&entry.root);
    let Some(mcp_path) =
        validate_manifest_relative_path(&root, "mcpServers", manifest.mcp_servers.as_deref())
            .ok()
            .flatten()
            .or_else(|| {
                let default_path = root.join(".mcp.json");
                default_path.is_file().then_some(default_path)
            })
            .or_else(|| {
                let default_path = root.join("mcp.json");
                default_path.is_file().then_some(default_path)
            })
    else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&mcp_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    parse_plugin_mcp_servers_file(value)
        .into_iter()
        .filter_map(|(name, config)| {
            let object = config.as_object()?;
            let transport = plugin_mcp_transport(object);
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .map(|value| resolve_plugin_runtime_path(&root, value));
            let args = plugin_mcp_string_array(object, "args").map(|items| {
                items
                    .into_iter()
                    .map(|value| resolve_plugin_runtime_path(&root, &value))
                    .collect::<Vec<_>>()
            });
            let env = plugin_mcp_env(object);
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let namespaced_name = format!("{}__{}", manifest.name, name);
            let oauth_value = plugin_mcp_runtime_metadata(plugin_id, &manifest.name, object);
            let is_stdio_command = transport == "stdio" && command.is_some();
            let cwd = resolve_plugin_cwd(&root, object.get("cwd").and_then(Value::as_str))
                .or_else(|| is_stdio_command.then(|| root.display().to_string()));
            Some(McpServerRecord {
                id: format!("plugin:{}:{}", plugin_id, name),
                name: namespaced_name,
                enabled: object
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                transport,
                command,
                args,
                env,
                cwd,
                url,
                oauth: Some(oauth_value),
            })
        })
        .collect()
}

pub(crate) fn sync_enabled_thrive_plugin_capabilities(
    state: &State<'_, AppState>,
) -> Result<Value, String> {
    let enabled_plugins = enabled_thrive_plugin_entries(state)?;
    let mut plugin_skills = Vec::<SkillRecord>::new();
    let mut plugin_mcp_servers = Vec::<McpServerRecord>::new();
    let mut plugin_hooks = Vec::<RuntimeHookRecord>::new();
    let mut plugin_ids = Vec::<String>::new();
    for (plugin_id, entry, manifest) in &enabled_plugins {
        plugin_ids.push(plugin_id.clone());
        plugin_skills.extend(discover_thrive_plugin_skill_records(
            plugin_id, entry, manifest,
        ));
        plugin_mcp_servers.extend(discover_thrive_plugin_mcp_servers(
            plugin_id, entry, manifest,
        ));
        let plugin_data_root = plugin_data_dir_for_id(state, plugin_id).ok();
        plugin_hooks.extend(discover_thrive_plugin_hooks(
            plugin_id,
            entry,
            manifest,
            plugin_data_root.as_deref(),
        ));
    }

    let next_mcp_servers = with_store_mut(state, |store| {
        store.skills.retain(|skill| {
            !skill
                .source_scope
                .as_deref()
                .unwrap_or_default()
                .starts_with("thrive-plugin:")
        });
        store.skills.extend(plugin_skills.clone());
        mcp_tools_store::replace_thrive_plugin_hooks(store, plugin_hooks.clone());
        Ok(mcp_tools_store::replace_thrive_plugin_servers(
            store,
            plugin_mcp_servers.clone(),
        ))
    })?;
    state.mcp_manager.sync_servers(&next_mcp_servers)?;

    Ok(json!({
        "success": true,
        "pluginIds": plugin_ids,
        "skills": plugin_skills.len(),
        "mcpServers": plugin_mcp_servers.len(),
        "hooks": plugin_hooks.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_plugin_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("redbox-plugin-mcp-test-{name}-{nonce}"));
        fs::create_dir_all(&root).expect("create temp plugin root");
        root
    }

    fn plugin_manifest(name: &str) -> RawThrivePluginManifest {
        RawThrivePluginManifest {
            name: name.to_string(),
            version: Some("1.0.0".to_string()),
            description: None,
            keywords: Vec::new(),
            min_app_version: None,
            platforms: Vec::new(),
            skills: None,
            mcp_servers: None,
            apps: None,
            hooks: None,
            actions: None,
            media: None,
            ui: BTreeMap::new(),
            permissions: RawThrivePluginPermissions::default(),
            interface: None,
            home: RawThrivePluginHome::default(),
        }
    }

    fn plugin_entry(root: &Path) -> ThrivePluginIndexEntry {
        ThrivePluginIndexEntry {
            enabled: true,
            active_version: "1.0.0".to_string(),
            marketplace: "local".to_string(),
            installed_at: "2026-06-16T00:00:00Z".to_string(),
            updated_at: "2026-06-16T00:00:00Z".to_string(),
            root: root.display().to_string(),
            granted_capabilities: Vec::new(),
            approval_required: Vec::new(),
        }
    }

    #[test]
    fn discovers_codex_wrapped_http_mcp_config() {
        let root = temp_plugin_root("http");
        fs::write(
            root.join(".mcp.json"),
            r#"{
  "$schema": "https://example.com/mcp.schema.json",
  "mcpServers": {
    "demo": {
      "type": "http",
      "url": "https://example.com/mcp",
      "oauth": { "clientId": "client-id", "callbackPort": 9876 },
      "env_http_headers": { "X-Token": "PLUGIN_TOKEN" },
      "enabled_tools": ["search"],
      "tool_timeout_sec": 7
    }
  }
}"#,
        )
        .expect("write mcp config");

        let servers = discover_thrive_plugin_mcp_servers(
            "demo-plugin@local",
            &plugin_entry(&root),
            &plugin_manifest("demo-plugin"),
        );

        assert_eq!(servers.len(), 1);
        let server = &servers[0];
        assert_eq!(server.transport, "streamable-http");
        assert_eq!(server.url.as_deref(), Some("https://example.com/mcp"));
        assert_eq!(
            server
                .oauth
                .as_ref()
                .and_then(|value| value.get("client_id"))
                .and_then(Value::as_str),
            Some("client-id")
        );
        assert!(server
            .oauth
            .as_ref()
            .and_then(|value| value.get("callbackPort"))
            .is_none());
        assert_eq!(
            server
                .oauth
                .as_ref()
                .and_then(|value| value.pointer("/redbox/envHttpHeaders/X-Token"))
                .and_then(Value::as_str),
            Some("PLUGIN_TOKEN")
        );
        assert_eq!(
            server
                .oauth
                .as_ref()
                .and_then(|value| value.pointer("/redbox/toolTimeoutSec"))
                .and_then(Value::as_u64),
            Some(7)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_direct_stdio_mcp_config_with_plugin_root_cwd() {
        let root = temp_plugin_root("stdio");
        fs::write(
            root.join(".mcp.json"),
            r#"{
  "demo": {
    "type": "stdio",
    "command": "node",
    "args": ["./server.js"],
    "env_vars": ["DEMO_TOKEN"]
  }
}"#,
        )
        .expect("write mcp config");

        let servers = discover_thrive_plugin_mcp_servers(
            "demo-plugin@local",
            &plugin_entry(&root),
            &plugin_manifest("demo-plugin"),
        );

        assert_eq!(servers.len(), 1);
        let server = &servers[0];
        assert_eq!(server.transport, "stdio");
        assert_eq!(server.command.as_deref(), Some("node"));
        assert_eq!(
            server.cwd.as_deref(),
            Some(root.to_str().expect("utf8 path"))
        );
        let expected_arg = root.join("server.js").display().to_string();
        assert_eq!(
            server
                .args
                .as_ref()
                .and_then(|args| args.first())
                .map(String::as_str),
            Some(expected_arg.as_str())
        );
        assert_eq!(
            server
                .oauth
                .as_ref()
                .and_then(|value| value.pointer("/redbox/envVars/0"))
                .and_then(Value::as_str),
            Some("DEMO_TOKEN")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_default_codex_hooks_file() {
        let root = temp_plugin_root("default-hooks");
        fs::create_dir_all(root.join("hooks")).expect("create hooks dir");
        fs::write(
            root.join("hooks/hooks.json"),
            r#"{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ./hooks/pre.js",
            "commandWindows": "node .\\hooks\\pre.js",
            "timeout": 12,
            "async": true,
            "statusMessage": "Checking"
          }
        ]
      }
    ]
  }
}"#,
        )
        .expect("write hooks config");

        let data_root = root.join("data");
        let hooks = discover_thrive_plugin_hooks(
            "demo-plugin@local",
            &plugin_entry(&root),
            &plugin_manifest("demo-plugin"),
            Some(&data_root),
        );

        assert_eq!(hooks.len(), 1);
        let hook = &hooks[0];
        assert_eq!(hook.event, "PreToolUse");
        assert_eq!(hook.r#type, "command");
        assert_eq!(hook.matcher.as_deref(), Some("bash"));
        assert_eq!(hook.command.as_deref(), Some("node ./hooks/pre.js"));
        assert_eq!(
            hook.command_windows.as_deref(),
            Some("node .\\hooks\\pre.js")
        );
        assert_eq!(hook.timeout_sec, Some(12));
        assert_eq!(hook.r#async, Some(true));
        assert_eq!(hook.status_message.as_deref(), Some("Checking"));
        assert_eq!(
            hook.source_scope.as_deref(),
            Some("thrive-plugin:demo-plugin@local")
        );
        assert_eq!(
            hook.source_relative_path.as_deref(),
            Some("hooks/hooks.json")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_hook_path_replaces_default_hooks_file() {
        let root = temp_plugin_root("manifest-hooks");
        fs::create_dir_all(root.join("hooks")).expect("create hooks dir");
        fs::write(
            root.join("hooks/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"prompt"}]}]}}"#,
        )
        .expect("write default hooks");
        fs::write(
            root.join("custom-hooks.json"),
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"agent"}]}]}}"#,
        )
        .expect("write custom hooks");
        let mut manifest = plugin_manifest("demo-plugin");
        manifest.hooks = Some(json!("./custom-hooks.json"));

        let data_root = root.join("data");
        let hooks = discover_thrive_plugin_hooks(
            "demo-plugin@local",
            &plugin_entry(&root),
            &manifest,
            Some(&data_root),
        );

        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, "SessionStart");
        assert_eq!(hooks[0].r#type, "agent");
        assert_eq!(
            hooks[0].source_relative_path.as_deref(),
            Some("custom-hooks.json")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_inline_manifest_hooks() {
        let root = temp_plugin_root("inline-hooks");
        fs::create_dir_all(root.join(".codex-plugin")).expect("create manifest dir");
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"demo-plugin","version":"1.0.0"}"#,
        )
        .expect("write manifest");
        let mut manifest = plugin_manifest("demo-plugin");
        manifest.hooks = Some(json!({
            "hooks": {
                "UserPromptSubmit": [
                    {
                        "matcher": ".*",
                        "hooks": [
                            { "type": "prompt" },
                            { "type": "agent" }
                        ]
                    }
                ]
            }
        }));

        let data_root = root.join("data");
        let hooks = discover_thrive_plugin_hooks(
            "demo-plugin@local",
            &plugin_entry(&root),
            &manifest,
            Some(&data_root),
        );

        assert_eq!(hooks.len(), 2);
        assert_eq!(hooks[0].event, "UserPromptSubmit");
        assert_eq!(hooks[0].r#type, "prompt");
        assert_eq!(hooks[1].r#type, "agent");
        assert_eq!(
            hooks[0].source_relative_path.as_deref(),
            Some("plugin.json#hooks[0]")
        );

        let _ = fs::remove_dir_all(root);
    }
}
