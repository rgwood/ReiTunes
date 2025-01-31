use clap::builder::Styles;

// IMO the v3 style was nice and it's dumb that clap removed colour in v4
pub fn clap_v3_style() -> Styles {
    use clap::builder::styling::AnsiColor;
    Styles::styled()
        .header(AnsiColor::Yellow.on_default())
        .usage(AnsiColor::Green.on_default())
        .literal(AnsiColor::Green.on_default())
        .placeholder(AnsiColor::Green.on_default())
}
