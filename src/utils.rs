use clap::builder::Styles;
use sha2::{Digest, Sha256};

/// Initialize tracing with appropriate settings
pub fn init_tracing() {
    // enable ansi escape codes in debug mode only, bit of a hack to disable 'em in Datadog logs
    let enable_ansi_colours = cfg!(debug_assertions);
    tracing_subscriber::fmt()
        .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
        .with_ansi(enable_ansi_colours)
        .init();
}

/// IMO the v3 style was nice and it's dumb that clap removed colour in v4
pub fn clap_v3_style() -> Styles {
    use clap::builder::styling::AnsiColor;
    Styles::styled()
        .header(AnsiColor::Yellow.on_default())
        .usage(AnsiColor::Green.on_default())
        .literal(AnsiColor::Green.on_default())
        .placeholder(AnsiColor::Green.on_default())
}

/// Hash the password with a salt that changes every quarter. Forces users to re-login every quarter.
/// The nice thing about personal projects is that I don't have to gaf about best practices 😎
pub fn hash_with_rotating_salt(password: &str) -> String {
    let now = jiff::Zoned::now();
    let quarter = match now.month() / 4 {
        0 => "Q1",
        1 => "Q2",
        2 => "Q3",
        3 => "Q4",
        _ => "Error",
    };

    // e.g. 2024-Q1
    let year_quarter_salt = format!("{}-{}", now.year(), quarter);

    let mut hasher = Sha256::new();
    hasher.update(password);
    hasher.update(year_quarter_salt);
    let result = hasher.finalize();
    format!("{:x}", result)
}
