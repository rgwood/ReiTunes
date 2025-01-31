use anyhow::{Context, Result};
use std::env;
use std::fs;
use std::path::PathBuf;

pub fn install() -> Result<()> {
    let executable_path = env::current_exe().context("Failed to get current executable path")?;
    let working_directory = executable_path
        .parent()
        .context("Failed to get parent directory of executable")?;
    let service_name = "reitunes.service";
    let service_content = format!(
        r#"[Unit]
Description=ReiTunes Music Player

[Service]
ExecStart={}
WorkingDirectory={}
Restart=on-failure

[Install]
WantedBy=multi-user.target
"#,
        executable_path.display(),
        working_directory.display()
    );

    let config_dir = dirs::config_dir()
        .context("Failed to get config directory")?
        .join("systemd")
        .join("user");

    fs::create_dir_all(&config_dir).context("Failed to create systemd user directory")?;

    let service_path: PathBuf = config_dir.join(service_name);
    fs::write(&service_path, service_content).context("Failed to write service file")?;

    println!(
        "Systemd user service installed at: {}",
        service_path.display()
    );
    println!(
        "To start the service, run: systemctl --user start {}",
        service_name
    );
    println!(
        "To enable the service to start on boot, run: systemctl --user enable {}",
        service_name
    );

    Ok(())
}
