use std::collections::BTreeMap;
use std::path::Path;

use crate::cli_runtime::installers::{CliInstallPlan, CliInstallerBackend, environment_bin_dir};
use crate::cli_runtime::{CliEnvironmentRecord, CliInstallMethod, CliInstallRequest};

#[derive(Debug, Clone, Copy)]
pub struct BinaryInstaller;

impl CliInstallerBackend for BinaryInstaller {
    fn kind(&self) -> CliInstallMethod {
        CliInstallMethod::Binary
    }

    fn prepare(
        &self,
        request: &CliInstallRequest,
        environment: &CliEnvironmentRecord,
        tool_command: &str,
    ) -> Result<CliInstallPlan, String> {
        let spec = request.spec.trim();
        if !(spec.starts_with("http://") || spec.starts_with("https://")) {
            return Err("binary install currently supports only direct download URLs".to_string());
        }
        Ok(CliInstallPlan {
            argv: vec![
                "curl".to_string(),
                "-fsSL".to_string(),
                spec.to_string(),
                "-o".to_string(),
                Path::new(&environment.root_path)
                    .join("bin")
                    .join(tool_command)
                    .to_string_lossy()
                    .to_string(),
            ],
            env: BTreeMap::new(),
            summary: format!(
                "Download binary {spec} into {}",
                environment_bin_dir(environment)
            ),
        })
    }
}
