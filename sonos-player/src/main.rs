use anyhow::Result;
use clap::Parser;
use logging::initialize_logging;
use sonos_player::*;
use std::path::PathBuf;

mod logging;
mod retry;
mod tui;
mod utils;

use tui::run_tui;

#[derive(Parser)]
#[command(author, version, about, long_about = None, styles = utils::clap_v3_style())]
struct Cli {}

#[tokio::main]
async fn main() -> Result<()> {
    initialize_logging()?;

    let _cli = Cli::parse();

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
