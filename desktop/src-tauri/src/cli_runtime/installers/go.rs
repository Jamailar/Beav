use std::collections::BTreeMap;

use crate::cli_runtime::installers::{environment_bin_dir, CliInstallPlan, CliInstallerBackend};
use crate::cli_runtime::{CliEnvironmentRecord, CliInstallMethod, CliInstallRequest};

#[derive(Debug, Clone, Copy)]
pub struct GoInstaller;

impl CliInstallerBackend for GoInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Go
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
        env.insert("GOBIN".to_string(), environment_bin_dir(environment));
        Ok(CliInstallPlan {
            argv: vec!["go".to_string(), "install".to_string(), spec.to_string()],
            env,
            summary: format!(
                "Install {spec} with go install into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}
