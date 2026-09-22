//! A real, public-metadata GLM/MusicBrainz session; no live services or key needed.
#[test]
fn recorded_live_session_replays_exact_requests_tools_and_accepted_tags() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/live-agent");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_tagging-eval"))
        .args(["replay", "--dir"])
        .arg(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
