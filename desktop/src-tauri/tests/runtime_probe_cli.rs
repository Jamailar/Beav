use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn probe_bin() -> &'static str {
    env!("CARGO_BIN_EXE_redbox_runtime_probe")
}

fn temp_output_dir(name: &str) -> PathBuf {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_millis();
    let path = std::env::temp_dir().join(format!("redbox-runtime-probe-{name}-{id}"));
    std::fs::create_dir_all(&path).expect("create temp output dir");
    path
}

#[test]
fn runtime_probe_cli_smoke_outputs_passed_report() {
    let output_dir = temp_output_dir("smoke");
    let output = Command::new(probe_bin())
        .args([
            "--output-dir",
            output_dir.to_str().expect("utf-8 temp path"),
            "smoke",
        ])
        .output()
        .expect("run redbox_runtime_probe smoke");

    assert!(
        output.status.success(),
        "probe failed\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value =
        serde_json::from_slice(&output.stdout).expect("probe stdout should be a JSON report");
    assert_eq!(
        report.get("scenario").and_then(Value::as_str),
        Some("smoke")
    );
    assert_eq!(report.get("status").and_then(Value::as_str), Some("passed"));
    let transcript = report
        .get("transcriptPath")
        .and_then(Value::as_str)
        .expect("transcriptPath");
    let bundle = report
        .get("bundlePath")
        .and_then(Value::as_str)
        .expect("bundlePath");
    assert!(std::path::Path::new(transcript).exists());
    assert!(std::path::Path::new(bundle).exists());
}

#[test]
fn runtime_probe_cli_run_all_covers_required_surfaces() {
    let output_dir = temp_output_dir("run-all");
    let output = Command::new(probe_bin())
        .args([
            "--output-dir",
            output_dir.to_str().expect("utf-8 temp path"),
            "run-all",
            "--provider",
            "mock",
        ])
        .output()
        .expect("run redbox_runtime_probe run-all");

    assert!(
        output.status.success(),
        "probe failed\nstdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let report: Value =
        serde_json::from_slice(&output.stdout).expect("run-all stdout should be one JSON report");
    assert_eq!(
        report.get("kind").and_then(Value::as_str),
        Some("redbox-runtime-probe-run-all")
    );
    assert_eq!(report.get("status").and_then(Value::as_str), Some("passed"));
    assert_eq!(report.get("failedCount").and_then(Value::as_u64), Some(0));
    let reports = report
        .get("reports")
        .and_then(Value::as_array)
        .expect("reports array");
    assert!(reports.len() >= 18, "expected all required probe scenarios");

    for scenario in [
        "mcp-call-tool",
        "cli-runtime-execute",
        "tool-call-contract",
        "skill-activation",
        "team-completion-summary",
        "wander-loop",
        "wander-to-creation",
        "redclaw-save-summary",
    ] {
        assert!(
            reports
                .iter()
                .any(|report| report.get("scenario").and_then(Value::as_str) == Some(scenario)),
            "missing {scenario}"
        );
    }

    assert!(reports.iter().all(|report| {
        report.get("finalMessageKind").and_then(Value::as_str) == Some("summary")
    }));
    for scenario in ["wander-loop", "wander-to-creation"] {
        let report = reports
            .iter()
            .find(|report| report.get("scenario").and_then(Value::as_str) == Some(scenario))
            .expect("wander report");
        assert!(report.get("idealLoop").is_some(), "missing ideal loop");
        assert_eq!(
            report
                .get("loopReview")
                .and_then(|review| review.get("status"))
                .and_then(Value::as_str),
            Some("passed")
        );
    }
}
