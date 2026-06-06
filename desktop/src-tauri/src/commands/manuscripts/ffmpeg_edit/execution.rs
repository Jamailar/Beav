use super::*;
use crate::cli_runtime::{run_managed_cli_command, CliExecuteRequest, CliVerifyRule};

pub(super) fn ffmpeg_seconds(ms: i64) -> String {
    format!("{:.3}", (ms.max(0) as f64) / 1000.0)
}

pub(super) fn ffmpeg_output_path(
    package_path: &std::path::Path,
    step_index: usize,
    op_name: &str,
    extension: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = package_path.join("cache").join("ai-edits");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(format!(
        "{:02}-{}-{}.{}",
        step_index + 1,
        op_name,
        now_ms(),
        extension
    )))
}

pub(super) fn run_ffmpeg_args(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    cwd: &std::path::Path,
    output_path: &std::path::Path,
    args: &[String],
) -> Result<(), String> {
    let argv = std::iter::once(ffmpeg_program(Some(app))?)
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    let _ = run_managed_cli_command(
        app,
        state,
        CliExecuteRequest {
            session_id: Some(session_id.to_string()),
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
    .map_err(|error| format!("执行 ffmpeg 失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ffmpeg_seconds;

    #[test]
    fn ffmpeg_seconds_clamps_negative_and_formats_millis() {
        assert_eq!(ffmpeg_seconds(-50), "0.000");
        assert_eq!(ffmpeg_seconds(1234), "1.234");
    }
}
