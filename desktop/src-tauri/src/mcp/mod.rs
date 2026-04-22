pub mod manager;
pub mod resources;
pub mod session;
pub mod transport;

pub use manager::{McpInvocationResult, McpManager, McpProbeResult};
pub use transport::discover_local_mcp_configs;
