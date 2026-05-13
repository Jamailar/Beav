use std::collections::BTreeMap;

use crate::cli_runtime::installers::{environment_bin_dir, CliInstallPlan, CliInstallerBackend};
use crate::cli_runtime::{CliEnvironmentRecord, CliInstallMethod, CliInstallRequest};

#[derive(Debug, Clone, Copy)]
pub struct NpmInstaller;

#[derive(Debug, Clone, Copy)]
pub struct PnpmInstaller;

impl CliInstallerBackend for NpmInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Npm
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
        let mut env = BTreeMap::new();
        env.insert(
            "npm_config_prefix".to_string(),
            environment.root_path.clone(),
        );
        Ok(CliInstallPlan {
            argv: vec![
                "npm".to_string(),
                "install".to_string(),
                "--prefix".to_string(),
                environment.root_path.clone(),
                "--no-save".to_string(),
                spec.to_string(),
            ],
            env,
            summary: format!(
                "Install {spec} with npm into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}

impl CliInstallerBackend for PnpmInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Pnpm
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
        let mut env = BTreeMap::new();
        env.insert("PNPM_HOME".to_string(), environment_bin_dir(environment));
        Ok(CliInstallPlan {
            argv: vec![
                "pnpm".to_string(),
                "add".to_string(),
                "--dir".to_string(),
                environment.root_path.clone(),
                spec.to_string(),
            ],
            env,
            summary: format!(
                "Install {spec} with pnpm into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}
