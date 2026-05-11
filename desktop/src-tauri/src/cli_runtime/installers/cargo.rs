use std::collections::BTreeMap;

use crate::cli_runtime::installers::{CliInstallPlan, CliInstallerBackend, environment_bin_dir};
use crate::cli_runtime::{CliEnvironmentRecord, CliInstallMethod, CliInstallRequest};

#[derive(Debug, Clone, Copy)]
pub struct CargoInstaller;

impl CliInstallerBackend for CargoInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Cargo
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
                "cargo".to_string(),
                "install".to_string(),
                "--root".to_string(),
                environment.root_path.clone(),
                spec.to_string(),
            ],
            env: BTreeMap::new(),
            summary: format!(
                "Install {spec} with cargo into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}
