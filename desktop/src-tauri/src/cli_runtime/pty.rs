use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};

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
) -> Result<CliTerminalHandle, String> {
    let program = argv
        .first()
        .cloned()
        .ok_or_else(|| "cli execute requires argv[0]".to_string())?;
    let mut command = Command::new(program);
    command.args(&argv[1..]);
    command.current_dir(cwd);
    command.envs(env);
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
        let error = spawn_cli_terminal(&[], &cwd, &env).expect_err("empty argv should fail");
        assert!(error.contains("argv[0]"));
    }
}
