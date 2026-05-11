use std::collections::BTreeMap;
use std::path::Path;

use crate::cli_runtime::installers::{CliInstallPlan, CliInstallerBackend, environment_bin_dir};
use crate::cli_runtime::{CliEnvironmentRecord, CliInstallMethod, CliInstallRequest};

#[derive(Debug, Clone, Copy)]
pub struct PythonInstaller;

#[derive(Debug, Clone, Copy)]
pub struct UvInstaller;

impl CliInstallerBackend for PythonInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Python
    }

    fn prepare(
        &self,
        request: &CliInstallRequest,
        environment: &CliEnvironmentRecord,
        _tool_command: &str,
    ) -> Result<CliInstallPlan, String> {
        let spec = request.spec.trim();
        if spec.is_empty() {
            return Err("spec is required for cli install".to_string());
        }
        Ok(CliInstallPlan {
            argv: vec![
                "python3".to_string(),
                "-m".to_string(),
                "pip".to_string(),
                "install".to_string(),
                "--prefix".to_string(),
                environment.root_path.clone(),
                spec.to_string(),
            ],
            env: BTreeMap::new(),
            summary: format!(
                "Install {spec} with pip into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}

impl CliInstallerBackend for UvInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Uv
    }

    fn prepare(
        &self,
        request: &CliInstallRequest,
        environment: &CliEnvironmentRecord,
        _tool_command: &str,
    ) -> Result<CliInstallPlan, String> {
        let spec = request.spec.trim();
        if spec.is_empty() {
            return Err("spec is required for cli install".to_string());
        }
        let root = Path::new(&environment.root_path);
        let mut env = BTreeMap::new();
        env.insert(
            "UV_TOOL_DIR".to_string(),
            root.join("uv-tools").to_string_lossy().to_string(),
        );
        env.insert(
            "UV_TOOL_BIN_DIR".to_string(),
            environment_bin_dir(environment),
        );
        Ok(CliInstallPlan {
            argv: vec![
                "uv".to_string(),
                "tool".to_string(),
                "install".to_string(),
                spec.to_string(),
            ],
            env,
            summary: format!(
                "Install {spec} with uv into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}
