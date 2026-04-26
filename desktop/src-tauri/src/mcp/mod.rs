pub mod config;
pub mod manager;
pub mod resources;
pub mod session;
pub mod team_server;
pub mod tool_exposure;
pub mod tool_inventory;
pub mod tool_names;
pub mod transport;

pub use manager::{McpInvocationResult, McpManager, McpProbeResult};
pub use resources::{resource_templates_from_response, resources_from_response};
pub use team_server::{
    execute_team_mcp_tool, team_mcp_tool_contracts, team_mcp_tools_list_response,
};
pub use tool_inventory::{McpToolInfo, McpToolInventorySnapshot};
pub use transport::discover_local_mcp_configs;
