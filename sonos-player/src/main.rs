use anyhow::Result;
use clap::Parser;
use logging::{initialize_logging, get_data_dir, LOG_FILE};
use reitunes_workspace::*;
use std::path::PathBuf;

mod logging;
mod retry;
mod tui;

use tui::run_tui;

#[derive(Parser)]
#[command(author, version, about, long_about = None, styles = clap_v3_style())]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Parser)]
enum Commands {
    /// Show the path to the logs file
    Logs,
}

#[tokio::main]
async fn main() -> Result<()> {
    initialize_logging()?;
    tracing::info!("Starting sonos-player v{}", env!("CARGO_PKG_VERSION"));

    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Logs) => {
            let log_path = get_data_dir().join(LOG_FILE.clone());
            println!("{}", log_path.display());
            return Ok(());
        }
        None => {
            // Default behavior - run the TUI
        }
    }

    let exe_path = std::env::current_exe()?;
    let fallback_path = PathBuf::from("."); // Fallback to current directory
    let exe_dir = exe_path.parent().unwrap_or(&fallback_path);
    let db_path = exe_dir.join("reitunes-library.db");
    let db = open_connection(db_path.to_str().unwrap())?;
    let library = load_library_from_db(&db)?;

    let devices = vec!["Living Room", "Kitchen", "Office"];
    run_tui(library, db, devices).await?;

    Ok(())
}
