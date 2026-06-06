use crate::cli_runtime::{run_managed_cli_command, CliExecuteRequest, CliVerifyRule};
use crate::{ffmpeg_program, now_ms, AppState};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

pub(super) fn ffmpeg_seconds(ms: i64) -> String {
    format!("{:.3}", (ms.max(0) as f64) / 1000.0)
}

pub(super) fn media_edit_output_path(
    output_dir: &Path,
    step_index: usize,
    op_name: &str,
    label: Option<&str>,
) -> PathBuf {
    let safe_label = label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                        ch
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .trim_matches('-')
                .chars()
                .take(32)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| op_name.to_string());
    output_dir.join(format!(
        "{:02}-{}-{}.mp4",
        step_index + 1,
        safe_label,
        now_ms()
    ))
}

pub(super) fn run_ffmpeg_args(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: Option<&str>,
    cwd: &Path,
    output_path: &Path,
    args: &[String],
) -> Result<(), String> {
    let argv = std::iter::once(ffmpeg_program(Some(app))?)
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    run_managed_cli_command(
        app,
        state,
        CliExecuteRequest {
            session_id: session_id.map(ToString::to_string),
            runtime_id: Some("media-edit".to_string()),
            tool_id: Some("ffmpeg".to_string()),
            argv,
            cwd: Some(cwd.to_string_lossy().to_string()),
            verification_rules: vec![
                CliVerifyRule::ExitCode { expected: Some(0) },
                CliVerifyRule::FileExists {
                    path: output_path.to_string_lossy().to_string(),
                },
            ],
            ..CliExecuteRequest::default()
        },
        8_000,
    )
    .map_err(|error| format!("ffmpeg failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ffmpeg_seconds;

    #[test]
    fn ffmpeg_seconds_clamps_negative_and_formats_millis() {
        assert_eq!(ffmpeg_seconds(-10), "0.000");
        assert_eq!(ffmpeg_seconds(2500), "2.500");
    }
}
