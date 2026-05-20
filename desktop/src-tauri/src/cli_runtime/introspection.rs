use std::collections::BTreeMap;
use std::path::Path;

use regex::Regex;

use crate::cli_runtime::{
    CliManifestCommand, CliOutputParser, CliToolHealth, CliToolManifestRecord, CliToolRecord,
};
use crate::now_i64;
use crate::process_utils::background_command;

const HELP_FLAGS: [(&str, &[&str]); 4] = [
    ("--help", &["--help"]),
    ("help", &["help"]),
    ("-h", &["-h"]),
    ("help-all", &["help", "--all"]),
];

fn manifest_id_for_tool(tool_id: &str) -> String {
    let suffix = tool_id.strip_prefix("cli-tool-").unwrap_or(tool_id);
    format!("cli-manifest-{suffix}")
}

fn first_non_empty_lines(content: &str, limit: usize) -> Vec<String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(limit)
        .map(ToString::to_string)
        .collect()
}

fn compact_help_excerpt(content: &str) -> Option<String> {
    let lines = first_non_empty_lines(content, 12);
    if lines.is_empty() {
        return None;
    }
    let mut excerpt = lines.join("\n");
    if excerpt.chars().count() > 1200 {
        excerpt = excerpt.chars().take(1200).collect();
    }
    Some(excerpt)
}

fn supports_json_output(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    lower.contains("--json")
        || lower.contains(" json ")
        || lower.contains("json output")
        || lower.contains("output json")
}

fn parse_help_commands(content: &str) -> Vec<CliManifestCommand> {
    let command_line =
        Regex::new(r"^\s{0,4}([A-Za-z0-9][A-Za-z0-9:_\-\.]+)\s{2,}(.+?)\s*$").expect("valid regex");
    let mut in_commands_section = false;
    let mut commands = Vec::<CliManifestCommand>::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if in_commands_section && !commands.is_empty() {
                break;
            }
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "commands:" | "subcommands:" | "available commands:" | "available subcommands:"
        ) {
            in_commands_section = true;
            continue;
        }

        if !in_commands_section {
            continue;
        }

        let Some(captures) = command_line.captures(line) else {
            if !commands.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') {
                break;
            }
            continue;
        };

        let Some(name) = captures.get(1).map(|value| value.as_str().trim()) else {
            continue;
        };
        let Some(summary) = captures.get(2).map(|value| value.as_str().trim()) else {
            continue;
        };
        if name.eq_ignore_ascii_case("usage") || name.eq_ignore_ascii_case("options") {
            continue;
        }
        commands.push(CliManifestCommand {
            name: name.to_string(),
            summary: summary.to_string(),
        });
        if commands.len() >= 24 {
            break;
        }
    }

    commands
}

fn run_probe(path: &Path, argv: &[&str]) -> Option<String> {
    let mut command = background_command(path);
    command.args(argv);
    let output = command.output().ok()?;
    if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() {
        return None;
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let trimmed = combined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn best_help_content(path: &Path) -> Option<String> {
    for (_, argv) in HELP_FLAGS {
        if let Some(content) = run_probe(path, argv) {
            return Some(content);
        }
    }
    None
}

pub fn build_cli_tool_manifest(
    tool: &CliToolRecord,
    _env: &BTreeMap<String, String>,
) -> Option<CliToolManifestRecord> {
    if tool.health != CliToolHealth::Ready {
        return None;
    }
    let resolved_path = tool
        .resolved_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(Path::new)?;
    let help_content = best_help_content(resolved_path)?;
    let commands = parse_help_commands(&help_content);
    let help_excerpt = compact_help_excerpt(&help_content);
    let json_output = supports_json_output(&help_content);
    Some(CliToolManifestRecord {
        id: manifest_id_for_tool(&tool.id),
        tool_id: tool.id.clone(),
        tool_name: tool.name.clone(),
        version: tool.version.clone(),
        supports_json_output: json_output,
        supports_version_flag: tool.version.is_some(),
        preferred_parser: if json_output {
            CliOutputParser::Json
        } else {
            CliOutputParser::Text
        },
        commands,
        generated_at: now_i64(),
        help_excerpt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_help_commands_reads_commands_section() {
        let commands = parse_help_commands(
            r#"
mytool 1.0

Commands:
  build    Build the output bundle
  serve    Start the local server
  doctor   Print diagnostics
"#,
        );

        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0].name, "build");
        assert!(commands[1].summary.contains("local server"));
    }

    #[test]
    fn supports_json_output_detects_common_flag() {
        assert!(supports_json_output("Usage: tool --json"));
        assert!(supports_json_output("Output JSON records"));
        assert!(!supports_json_output("plain text only"));
    }
}
