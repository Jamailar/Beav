pub mod manager;
pub mod resources;
pub mod session;
pub mod team_server;
pub mod transport;

pub use manager::{McpInvocationResult, McpManager, McpProbeResult};
pub use team_server::{
    execute_team_mcp_tool, team_mcp_tool_contracts, team_mcp_tools_list_response,
};
pub use transport::discover_local_mcp_configs;
