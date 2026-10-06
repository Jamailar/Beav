use super::*;

pub(in crate::commands::cli_runtime) fn tool_source_for_environment(
    environment: &CliEnvironmentRecord,
) -> CliToolSource {
    match environment.scope {
        CliEnvironmentScope::WorkspaceLocal => CliToolSource::WorkspaceManaged,
        CliEnvironmentScope::AppGlobal | CliEnvironmentScope::TaskEphemeral => {
            CliToolSource::AppManaged
        }
    }
}

pub(super) fn environment_scope_rank(scope: &CliEnvironmentScope) -> u8 {
    match scope {
        CliEnvironmentScope::AppGlobal => 0,
        CliEnvironmentScope::WorkspaceLocal => 1,
        CliEnvironmentScope::TaskEphemeral => 2,
    }
}

fn merge_tool_metadata(existing: Option<&Value>, generated: Option<Value>) -> Option<Value> {
    let mut merged = serde_json::Map::<String, Value>::new();
    if let Some(Value::Object(object)) = existing {
        for (key, value) in object {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(Value::Object(object)) = generated {
        for (key, value) in object {
            merged.insert(key, value);
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(Value::Object(merged))
    }
}

pub(in crate::commands::cli_runtime) fn attach_effective_environment_metadata(
    mut tool: CliToolRecord,
    host: &CliHostShellSnapshot,
    effective: &CliEffectiveEnvironment,
) -> CliToolRecord {
    tool.metadata = merge_tool_metadata(
        tool.metadata.as_ref(),
        Some(json!({
            "hostShell": host.metadata_value(),
            "effectiveEnvironment": effective.metadata_value(),
        })),
    );
    tool
}

fn manifest_metadata(manifest: &CliToolManifestRecord) -> Value {
    json!({
        "commandCount": manifest.commands.len(),
        "supportsJsonOutput": manifest.supports_json_output,
        "supportsVersionFlag": manifest.supports_version_flag,
        "helpExcerpt": manifest.help_excerpt,
        "preferredParser": manifest.preferred_parser,
        "manifestGeneratedAt": manifest.generated_at,
    })
}

pub(in crate::commands::cli_runtime) fn merge_detected_tool_with_stored(
    detected: CliToolRecord,
    stored: Option<&CliToolRecord>,
    environment: Option<&CliEnvironmentRecord>,
    manifest: Option<&CliToolManifestRecord>,
) -> CliToolRecord {
    let mut merged = detected;
    if let Some(stored) = stored {
        if merged.name.trim().is_empty() {
            merged.name = stored.name.clone();
        }
        if merged.executable.trim().is_empty() {
            merged.executable = stored.executable.clone();
        }
        merged.install_method = stored.install_method.clone().or(merged.install_method);
        merged.install_spec = stored.install_spec.clone().or(merged.install_spec);
        merged.manifest_id = stored.manifest_id.clone().or(merged.manifest_id);
        merged.environment_id = merged
            .environment_id
            .clone()
            .or(stored.environment_id.clone());
        merged.resolved_from = merged
            .resolved_from
            .clone()
            .or(stored.resolved_from.clone());
        if merged.effective_path_preview.is_empty() {
            merged.effective_path_preview = stored.effective_path_preview.clone();
        }
        merged.searched_path_entries_count = merged
            .searched_path_entries_count
            .or(stored.searched_path_entries_count);
        merged.is_in_default_detect_catalog |= stored.is_in_default_detect_catalog;
        if matches!(merged.source, CliToolSource::System)
            && !matches!(stored.source, CliToolSource::System)
            && merged.health != CliToolHealth::Ready
        {
            merged.source = stored.source.clone();
        }
        merged.metadata = merge_tool_metadata(stored.metadata.as_ref(), merged.metadata);
    }
    if let Some(environment) = environment {
        merged.environment_id = Some(environment.id.clone());
        merged.source = tool_source_for_environment(environment);
    }
    if let Some(manifest) = manifest {
        merged.manifest_id = Some(manifest.id.clone());
        merged.metadata =
            merge_tool_metadata(merged.metadata.as_ref(), Some(manifest_metadata(manifest)));
    }
    merged
}
