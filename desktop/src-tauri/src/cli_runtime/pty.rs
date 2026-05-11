use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::cli_runtime::{CliSandboxSpec, prepare_cli_launch};
use crate::process_utils::configure_background_command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliTerminalTransport {
    Pipes,
}

pub struct CliTerminalHandle {
    pub child: Child,
    pub transport: CliTerminalTransport,
}

pub fn spawn_cli_terminal(
    argv: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    sandbox: &CliSandboxSpec,
) -> Result<CliTerminalHandle, String> {
    let launch = prepare_cli_launch(sandbox, argv, env)?;
    let mut command = Command::new(launch.program);
    command.args(&launch.args);
    command.current_dir(cwd);
    command.envs(&launch.env);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    configure_background_command(&mut command);
    let child = command.spawn().map_err(|error| error.to_string())?;
    Ok(CliTerminalHandle {
        child,
        transport: CliTerminalTransport::Pipes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_cli_terminal_rejects_empty_argv() {
        let env = BTreeMap::new();
        let cwd = std::env::temp_dir();
        let error = match spawn_cli_terminal(&[], &cwd, &env, &CliSandboxSpec::default()) {
            Ok(_) => panic!("empty argv should fail"),
            Err(error) => error,
        };
        assert!(error.contains("argv[0]"));
    }
}
