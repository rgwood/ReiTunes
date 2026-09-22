fn main() {
    println!("cargo:rerun-if-env-changed=TAGGING_CODE_REVISION");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=agent-prompt.txt");
    let revision = std::env::var("TAGGING_CODE_REVISION").unwrap_or_else(|_| {
        std::process::Command::new("git")
            .args(["describe", "--always", "--dirty"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "unknown".into())
    });
    println!("cargo:rustc-env=TAGGING_BUILD_REVISION={revision}");
}
