use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliToolSource {
    #[default]
    System,
    AppManaged,
    WorkspaceManaged,
    UserDeclared,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliInstallMethod {
    #[default]
    Manual,
    Npm,
    Pnpm,
    Python,
    Uv,
    Cargo,
    Go,
    Binary,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliToolHealth {
    #[default]
    Unknown,
    Ready,
    Missing,
    Broken,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliResolvedFrom {
    #[default]
    Unknown,
    HostShellPath,
    ExtraBinPath,
    ManagedEnvironment,
    ExplicitPath,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliEnvironmentScope {
    #[default]
    AppGlobal,
    WorkspaceLocal,
    TaskEphemeral,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliExecutionMode {
    Managed,
    #[default]
    HostCompatible,
    Unrestricted,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliOutputParser {
    #[default]
    Text,
    Json,
    Lines,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliExecutionStatus {
    #[default]
    Pending,
    AwaitingEscalation,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliVerificationStatus {
    #[default]
    Unknown,
    Pending,
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliEscalationReason {
    #[default]
    DangerousCommand,
    PathOutsideWorkspace,
    SensitivePath,
    NetworkAccess,
    GlobalInstall,
    ElevatedPrivilege,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliEscalationStatus {
    #[default]
    Pending,
    Approved,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CliVerifierKind {
    #[default]
    ExitCode,
    FileExists,
    OutputContains,
    JsonSchema,
    CustomCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliRuntimeInventory {
    pub node: Option<String>,
    pub python: Option<String>,
    pub uv: Option<String>,
    pub pnpm: Option<String>,
    pub cargo: Option<String>,
    pub go: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliToolRecord {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub resolved_path: Option<String>,
    pub resolved_from: Option<CliResolvedFrom>,
    pub environment_id: Option<String>,
    pub source: CliToolSource,
    pub install_method: Option<CliInstallMethod>,
    pub install_spec: Option<String>,
    pub version: Option<String>,
    pub health: CliToolHealth,
    pub manifest_id: Option<String>,
    pub last_checked_at: Option<i64>,
    pub effective_path_preview: Vec<String>,
    pub searched_path_entries_count: Option<usize>,
    pub is_in_default_detect_catalog: bool,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliEnvironmentRecord {
    pub id: String,
    pub scope: CliEnvironmentScope,
    pub root_path: String,
    pub workspace_root: Option<String>,
    pub path_entries: Vec<String>,
    pub runtimes: CliRuntimeInventory,
    pub installed_tool_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliManifestCommand {
    pub name: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliToolManifestRecord {
    pub id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub version: Option<String>,
    pub supports_json_output: bool,
    pub supports_version_flag: bool,
    pub preferred_parser: CliOutputParser,
    pub commands: Vec<CliManifestCommand>,
    pub generated_at: i64,
    pub help_excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliExecutionRecord {
    pub id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub environment_id: String,
    pub tool_id: Option<String>,
    pub command: Vec<String>,
    pub cwd: String,
    pub status: CliExecutionStatus,
    pub exit_code: Option<i32>,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub artifact_paths: Vec<String>,
    pub verification_status: CliVerificationStatus,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliPermissionGrantSet {
    pub network: bool,
    pub write_outside_workspace: bool,
    pub sensitive_paths: bool,
    pub global_install: bool,
    pub elevated_privilege: bool,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliEscalationRequestRecord {
    pub id: String,
    pub execution_id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub reason: CliEscalationReason,
    pub requested_permissions: CliPermissionGrantSet,
    pub status: CliEscalationStatus,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliVerificationRecord {
    pub id: String,
    pub execution_id: String,
    pub verifier: CliVerifierKind,
    pub status: CliVerificationStatus,
    pub summary: String,
    pub detail: Option<Value>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliExecutionSnapshot {
    pub execution: CliExecutionRecord,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub verifications: Vec<CliVerificationRecord>,
    pub escalation: Option<CliEscalationRequestRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliDetectRequest {
    pub commands: Vec<String>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliDiscoverRequest {
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliCreateEnvironmentRequest {
    pub scope: CliEnvironmentScope,
    pub workspace_root: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliEnvironmentResolveRequest {
    pub requested_environment_id: Option<String>,
    pub preferred_scope: Option<CliEnvironmentScope>,
    pub workspace_root: Option<String>,
    pub task_id: Option<String>,
    pub tool_id: Option<String>,
    pub isolated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliEnvironmentResolution {
    pub environment: CliEnvironmentRecord,
    pub reason: String,
    pub reused_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliExecuteRequest {
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub environment_id: Option<String>,
    pub tool_id: Option<String>,
    pub execution_mode: Option<CliExecutionMode>,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub use_pty: bool,
    pub verification_rules: Vec<CliVerifyRule>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliInstallRequest {
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub runtime_id: Option<String>,
    pub environment_id: Option<String>,
    pub execution_mode: Option<CliExecutionMode>,
    pub install_method: CliInstallMethod,
    pub spec: String,
    pub tool_name: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliApproveEscalationRequest {
    pub escalation_id: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliDenyEscalationRequest {
    pub escalation_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliVerifyExecutionRequest {
    pub execution_id: String,
    pub rules: Vec<CliVerifyRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliVerifyRule {
    ExitCode {
        expected: Option<i32>,
    },
    FileExists {
        path: String,
    },
    OutputContains {
        stream: Option<String>,
        text: String,
    },
    JsonSchema {
        stream: Option<String>,
        required_keys: Vec<String>,
    },
    CustomCommand {
        argv: Vec<String>,
        cwd: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliInstallResult {
    pub success: bool,
    pub installed: bool,
    pub install_id: String,
    pub status: CliExecutionStatus,
    pub environment_id: String,
    pub tool_id: Option<String>,
    pub tool_name: Option<String>,
    pub install_method: CliInstallMethod,
    pub spec: String,
    pub summary: String,
    pub execution: Option<CliExecutionRecord>,
    pub tool: Option<CliToolRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CliVerifyResult {
    pub success: bool,
    pub execution_id: String,
    pub status: CliVerificationStatus,
    pub summary: String,
    pub verifications: Vec<CliVerificationRecord>,
    pub execution: Option<CliExecutionRecord>,
}

pub fn cli_runtime_inventory_commands() -> [(&'static str, &'static str); 6] {
    [
        ("node", "node"),
        ("python", "python3"),
        ("uv", "uv"),
        ("pnpm", "pnpm"),
        ("cargo", "cargo"),
        ("go", "go"),
    ]
}
