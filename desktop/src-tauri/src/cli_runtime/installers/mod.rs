use std::collections::BTreeMap;
use std::path::Path;

use crate::cli_runtime::{CliEnvironmentRecord, CliInstallMethod, CliInstallRequest};

mod binary;
mod cargo;
mod go;
mod npm;
mod python;

pub use binary::BinaryInstaller;
pub use cargo::CargoInstaller;
pub use go::GoInstaller;
pub use npm::{NpmInstaller, PnpmInstaller};
pub use python::{PythonInstaller, UvInstaller};

#[derive(Debug, Clone)]
pub struct CliInstallPlan {
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub summary: String,
}

pub trait CliInstallerBackend {
    fn kind(&self) -> CliInstallMethod;
    fn prepare(
        &self,
        request: &CliInstallRequest,
        environment: &CliEnvironmentRecord,
        tool_command: &str,
    ) -> Result<CliInstallPlan, String>;
}

pub fn environment_bin_dir(environment: &CliEnvironmentRecord) -> String {
    Path::new(&environment.root_path)
        .join("bin")
        .to_string_lossy()
        .to_string()
}

pub fn prepare_cli_install(
    request: &CliInstallRequest,
    environment: &CliEnvironmentRecord,
    tool_command: &str,
) -> Result<CliInstallPlan, String> {
    match request.install_method {
        CliInstallMethod::Manual => Err("manual install must be performed by the user".to_string()),
        CliInstallMethod::Npm => NpmInstaller.prepare(request, environment, tool_command),
        CliInstallMethod::Pnpm => PnpmInstaller.prepare(request, environment, tool_command),
        CliInstallMethod::Python => PythonInstaller.prepare(request, environment, tool_command),
        CliInstallMethod::Uv => UvInstaller.prepare(request, environment, tool_command),
        CliInstallMethod::Cargo => CargoInstaller.prepare(request, environment, tool_command),
        CliInstallMethod::Go => GoInstaller.prepare(request, environment, tool_command),
        CliInstallMethod::Binary => BinaryInstaller.prepare(request, environment, tool_command),
    }
}
