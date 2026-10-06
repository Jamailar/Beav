use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};

pub const MCP_TOOL_NAME_PREFIX: &str = "mcp__";
pub const MAX_MCP_TOOL_NAME_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RawMcpToolIdentity {
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
}

pub fn qualified_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let namespace = sanitize_name_part(server_name);
    let callable = sanitize_name_part(tool_name);
    trim_with_hash(&format!("{MCP_TOOL_NAME_PREFIX}{namespace}__{callable}"))
}

pub fn qualify_mcp_tools(raw: &[RawMcpToolIdentity]) -> BTreeMap<RawMcpToolIdentity, String> {
    let mut used = BTreeSet::<String>::new();
    let mut result = BTreeMap::<RawMcpToolIdentity, String>::new();
    for identity in raw {
        let base = qualified_mcp_tool_name(&identity.server_name, &identity.tool_name);
        let mut candidate = base.clone();
        if used.contains(&candidate) {
            candidate = trim_with_hash(&format!(
                "{}__{}",
                base.trim_end_matches('_'),
                short_hash(&format!(
                    "{}:{}:{}",
                    identity.server_id, identity.server_name, identity.tool_name
                ))
            ));
        }
        while used.contains(&candidate) {
            candidate = trim_with_hash(&format!(
                "{}__{}",
                base.trim_end_matches('_'),
                short_hash(&format!("{}:{}", identity.server_id, used.len()))
            ));
        }
        used.insert(candidate.clone());
        result.insert(identity.clone(), candidate);
    }
    result
}

fn sanitize_name_part(input: &str) -> String {
    let mut output = String::new();
    let mut previous_underscore = false;
    for ch in input.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else {
            '_'
        };
        if next == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        output.push(next);
    }
    let output = output.trim_matches('_').to_string();
    if output.is_empty() {
        "tool".to_string()
    } else {
        output
    }
}

fn trim_with_hash(input: &str) -> String {
    if input.len() <= MAX_MCP_TOOL_NAME_BYTES {
        return input.to_string();
    }
    let suffix = format!("__{}", short_hash(input));
    let max_prefix = MAX_MCP_TOOL_NAME_BYTES.saturating_sub(suffix.len());
    let mut prefix = String::new();
    for ch in input.chars() {
        if prefix.len() + ch.len_utf8() > max_prefix {
            break;
        }
        prefix.push(ch);
    }
    format!("{}{}", prefix.trim_end_matches('_'), suffix)
}

fn short_hash(input: &str) -> String {
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:08x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_name_sanitizes_and_trims() {
        let name = qualified_mcp_tool_name("Demo Server", "read:file.now");
        assert_eq!(name, "mcp__demo_server__read_file_now");
    }

    #[test]
    fn duplicate_tool_names_get_unique_suffixes() {
        let items = vec![
            RawMcpToolIdentity {
                server_id: "a".to_string(),
                server_name: "Demo".to_string(),
                tool_name: "read".to_string(),
            },
            RawMcpToolIdentity {
                server_id: "b".to_string(),
                server_name: "Demo".to_string(),
                tool_name: "read".to_string(),
            },
        ];
        let qualified = qualify_mcp_tools(&items);
        let names = qualified.values().cloned().collect::<BTreeSet<_>>();
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|name| name.starts_with("mcp__demo__read")));
    }

    #[test]
    fn long_names_stay_within_provider_limit() {
        let name = qualified_mcp_tool_name(
            "server-with-a-very-long-name-that-needs-to-be-trimmed",
            "tool-with-a-very-long-name-that-needs-to-be-trimmed",
        );
        assert!(name.len() <= MAX_MCP_TOOL_NAME_BYTES);
        assert!(name.starts_with(MCP_TOOL_NAME_PREFIX));
    }
}
