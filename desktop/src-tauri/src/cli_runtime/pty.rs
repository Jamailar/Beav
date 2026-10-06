use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};

use portable_pty::{
    native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize as PortablePtySize,
};

use crate::cli_runtime::{prepare_cli_launch, CliSandboxSpec};
use crate::process_utils::background_command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliTerminalTransport {
    Pipes,
    Pty,
}

pub enum CliTerminalHandle {
    Pipes {
        child: Child,
    },
    Pty {
        child: Box<dyn PtyChild + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
    },
}

pub fn spawn_cli_terminal(
    argv: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    sandbox: &CliSandboxSpec,
    use_pty: bool,
) -> Result<CliTerminalHandle, String> {
    let launch = prepare_cli_launch(sandbox, argv, env)?;
    if use_pty {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PortablePtySize::default())
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(&launch.program);
        command.args(&launch.args);
        command.cwd(cwd.as_os_str());
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        return Ok(CliTerminalHandle::Pty {
            child,
            master: pair.master,
            reader,
            writer,
        });
    }

    let mut command = background_command(launch.program);
    command.args(&launch.args);
    command.current_dir(cwd);
    command.envs(&launch.env);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let child = command.spawn().map_err(|error| error.to_string())?;
    Ok(CliTerminalHandle::Pipes { child })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliTerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl Default for CliTerminalSize {
    fn default() -> Self {
        Self { rows: 24, cols: 80 }
    }
}

impl From<CliTerminalSize> for PortablePtySize {
    fn from(size: CliTerminalSize) -> Self {
        Self {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_cli_terminal_rejects_empty_argv() {
        let env = BTreeMap::new();
        let cwd = std::env::temp_dir();
        let error = match spawn_cli_terminal(&[], &cwd, &env, &CliSandboxSpec::default(), false) {
            Ok(_) => panic!("empty argv should fail"),
            Err(error) => error,
        };
        assert!(error.contains("argv[0]"));
    }

    #[test]
    fn terminal_size_converts_to_portable_pty_size() {
        let size: PortablePtySize = CliTerminalSize {
            rows: 40,
            cols: 120,
        }
        .into();
        assert_eq!(size.rows, 40);
        assert_eq!(size.cols, 120);
    }
}
