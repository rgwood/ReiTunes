use anyhow::Result;
use crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::stream::StreamExt;
use ratatui::{
    backend::{Backend, CrosstermBackend},
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    symbols::border,
    widgets::{Block, Borders, Cell, Padding, Paragraph, Row, Table, TableState},
    Frame, Terminal,
};
use rusqlite::Connection;
use sonos::{av_transport::SeekRequest, SonosDevice, TrackMetaData, TransportState};
use reitunes_workspace::{download_and_save_events, load_library_from_db, Library, LibraryItem};
use std::{io, sync::Arc, time::Duration};
use tokio::{
    select,
    sync::{mpsc, watch, Mutex},
};
use tracing::{info, warn};
use tui_textarea::{TextArea, Input};

use crate::retry::{
    pause_with_retry, play_with_retry, seek_with_retry, set_av_transport_uri_with_retry,
    stop_with_retry,
};

enum InputEvent {
    Input(KeyEvent),
    Tick,
    TrackMetadataChanged(Option<TrackMetaData>),
    TransportStateChanged(TransportState),
}

struct App {
    conn: Connection,
    device: SonosDevice,
    device_name: String,
    items: Vec<LibraryItem>,
    filtered_items: Vec<LibraryItem>,
    state: TableState,
    current_track: Option<TrackMetaData>,
    transport_state: TransportState,
    devices: Vec<&'static str>,
    current_device_index: usize,
    library: Library,
    search_textarea: TextArea<'static>,
    search_mode: bool,
}

impl App {
    fn update_filtered_items(&mut self) {
        let search_query = self.search_textarea.lines().join(" ");
        if self.search_mode && !search_query.is_empty() {
            let query = search_query.to_lowercase();
            self.filtered_items = self.items.iter()
                .filter(|item| {
                    item.name.to_lowercase().contains(&query) ||
                    item.artist.to_lowercase().contains(&query) ||
                    item.album.to_lowercase().contains(&query)
                })
                .cloned()
                .collect();
        } else {
            self.filtered_items = self.items.clone();
        }
        
        // Reset selection when filtering
        if self.filtered_items.is_empty() {
            self.state.select(None);
        } else {
            self.state.select(Some(0));
        }
    }
}

pub async fn run_tui(library: Library, conn: Connection, devices: Vec<&'static str>) -> Result<()> {
    let start_time = std::time::Instant::now();
    let initial_device = SonosDevice::for_room(devices[0]).await?;
    info!("Time to get Sonos device: {:?}", start_time.elapsed());
    
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    
    let (tx, rx) = mpsc::channel(32);
    let (device_tx, device_rx) = watch::channel(initial_device.clone());

    let tx_clone = tx.clone();
    let input_tick_task = tokio::spawn(async move {
        let tick_rate = Duration::from_millis(1200);
        let mut reader = crossterm::event::EventStream::new();
        let mut interval = tokio::time::interval(tick_rate);
        loop {
            select! {
                item = reader.next() => {
                    match item {
                        Some(Ok(event)) => {
                            if let Event::Key(key_event) = event {
                                if tx_clone.send(InputEvent::Input(key_event)).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Some(Err(e)) => warn!("Error reading event: {:?}", e),
                        None => {
                            info!("Event stream ended");
                            break;
                        },
                    }
                }
                _ = interval.tick() => {
                    if tx_clone.send(InputEvent::Tick).await.is_err() {
                        break;
                    }
                }
            }
        }
        info!("Exiting input loop");
    });

    let mut items: Vec<LibraryItem> = library.items.values().cloned().collect();
    items.sort_by(|a, b| b.created_time_utc.cmp(&a.created_time_utc));
    let filtered_items = items.clone();
    let mut state = TableState::default();
    state.select(Some(0));
    let device_name = initial_device.name().await?;
    
    let mut search_textarea = TextArea::default();
    search_textarea.set_cursor_line_style(Style::default());
    search_textarea.set_block(
        Block::default()
            .borders(Borders::ALL)
            .border_set(border::ROUNDED)
            .title("─Search")
            .title_style(
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )
            .border_style(Style::default().fg(Color::Yellow))
    );
    search_textarea.set_placeholder_text("Type to search songs by name, artist, or album...");
    
    let app = Arc::new(Mutex::new(App {
        conn,
        device: initial_device.clone(),
        device_name,
        items,
        filtered_items,
        state,
        current_track: None,
        transport_state: TransportState::Stopped,
        devices,
        current_device_index: 0,
        library,
        search_textarea,
        search_mode: false,
    }));

    let tx_clone = tx.clone();

    let av_transport_task = tokio::spawn(av_transport_handler(device_rx, tx_clone));

    let res = run_app(&mut terminal, app, rx, device_tx).await;
    input_tick_task.abort();
    av_transport_task.abort();

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    if let Err(err) = res {
        println!("{:?}", err)
    }

    Ok(())
}

async fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    app: Arc<Mutex<App>>,
    mut rx: mpsc::Receiver<InputEvent>,
    device_tx: watch::Sender<SonosDevice>,
) -> Result<()> {
    loop {
        match rx.recv().await {
            Some(InputEvent::Input(key_event)) => {
                let mut app = app.lock().await;
                match key_event {
                    KeyEvent {
                        code: KeyCode::Char('f'),
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } => {
                        if !app.search_mode {
                            app.search_mode = true;
                            app.search_textarea.select_all();
                            app.search_textarea.delete_line_by_head();
                            app.update_filtered_items();
                        }
                    }
                    KeyEvent {
                        code: KeyCode::Char('q'),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => return Ok(()),
                    KeyEvent {
                        code: KeyCode::Esc,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        if app.search_mode {
                            app.search_mode = false;
                            app.search_textarea.select_all();
                            app.search_textarea.delete_line_by_head();
                            app.update_filtered_items();
                        }
                    }
                    // Handle typing in search mode - only printable characters and basic editing keys
                    KeyEvent {
                        code: KeyCode::Char(_),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    KeyEvent {
                        code: KeyCode::Backspace,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    KeyEvent {
                        code: KeyCode::Delete,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    // Text editing keys for search mode
                    KeyEvent {
                        code: KeyCode::Home,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    KeyEvent {
                        code: KeyCode::End,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    // Use Ctrl+Left/Right for cursor movement in search mode
                    KeyEvent {
                        code: KeyCode::Left,
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    KeyEvent {
                        code: KeyCode::Right,
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    // Ctrl+A to select all in search mode
                    KeyEvent {
                        code: KeyCode::Char('a'),
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    // Ctrl+U to clear line in search mode
                    KeyEvent {
                        code: KeyCode::Char('u'),
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if app.search_mode => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    // All other keys (including Up/Down/Enter/Space) work normally in search mode
                    KeyEvent {
                        code: KeyCode::Down,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        let len = if app.search_mode {
                            app.filtered_items.len()
                        } else {
                            app.items.len()
                        };
                        if len > 0 {
                            let i = match app.state.selected() {
                                Some(i) => {
                                    if i >= len - 1 {
                                        0
                                    } else {
                                        i + 1
                                    }
                                }
                                None => 0,
                            };
                            app.state.select(Some(i));
                        }
                    }
                    KeyEvent {
                        code: KeyCode::Up,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        let len = if app.search_mode {
                            app.filtered_items.len()
                        } else {
                            app.items.len()
                        };
                        if len > 0 {
                            let i = match app.state.selected() {
                                Some(i) => {
                                    if i == 0 {
                                        len - 1
                                    } else {
                                        i - 1
                                    }
                                }
                                None => 0,
                            };
                            app.state.select(Some(i));
                        }
                    }
                    KeyEvent {
                        code: KeyCode::Right,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        // Seek forward by 30 seconds
                        let _ = seek_with_retry(
                            &app.device,
                            SeekRequest {
                                instance_id: 0,
                                unit: sonos::SeekMode::TimeDelta,
                                target: "+00:00:30".into(),
                            },
                        )
                        .await;
                    }
                    KeyEvent {
                        code: KeyCode::Left,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        // Seek backward by 30 seconds
                        let _ = seek_with_retry(
                            &app.device,
                            SeekRequest {
                                instance_id: 0,
                                unit: sonos::SeekMode::TimeDelta,
                                target: "-00:00:30".into(),
                            },
                        )
                        .await;
                    }
                    KeyEvent {
                        code: KeyCode::Enter,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        if let Some(selected) = app.state.selected() {
                            let items = if app.search_mode {
                                &app.filtered_items
                            } else {
                                &app.items
                            };
                            if selected < items.len() {
                                let item = &items[selected];
                                let _ = play_song(&app.device, item).await;
                            }
                        }
                    }
                    KeyEvent {
                        code: KeyCode::Char(' '),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => match app.transport_state {
                        TransportState::Stopped => play_with_retry(&app.device).await?,
                        TransportState::Playing => pause_with_retry(&app.device).await?,
                        TransportState::PausedPlayback => play_with_retry(&app.device).await?,
                        _ => {}
                    },
                    KeyEvent {
                        code: KeyCode::Char('['),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        app.current_device_index =
                            (app.current_device_index + app.devices.len() - 1) % app.devices.len();
                        let new_device =
                            SonosDevice::for_room(app.devices[app.current_device_index]).await?;
                        app.device = new_device.clone();
                        app.device_name = app.device.name().await?;
                        app.current_track = None;
                        app.transport_state = TransportState::Unspecified("Unknown".into());
                        device_tx.send(new_device).ok();
                    }
                    KeyEvent {
                        code: KeyCode::Char(']'),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        app.current_device_index =
                            (app.current_device_index + 1) % app.devices.len();
                        let new_device =
                            SonosDevice::for_room(app.devices[app.current_device_index]).await?;
                        app.device = new_device.clone();
                        app.device_name = app.device.name().await?;
                        app.current_track = None;
                        app.transport_state = TransportState::Unspecified("Unknown".into());
                        device_tx.send(new_device).ok();
                    }
                    KeyEvent {
                        code: KeyCode::Char('r'),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        play_random_bookmark(&app.device, &app.library).await?;
                    }
                    KeyEvent {
                        code: KeyCode::Char('p'),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        download_and_save_events(&mut app.conn).await?;
                        app.library = load_library_from_db(&app.conn)?;
                        let mut items: Vec<LibraryItem> =
                            app.library.items.values().cloned().collect();
                        items.sort_by(|a, b| b.created_time_utc.cmp(&a.created_time_utc));
                        app.items = items;
                        app.update_filtered_items();
                        app.state.select(Some(0));
                    }
                    _ => {}
                }
            }
            Some(InputEvent::Tick) => {}
            Some(InputEvent::TrackMetadataChanged(metadata)) => {
                let mut app = app.lock().await;
                app.current_track = metadata;
            }
            Some(InputEvent::TransportStateChanged(state)) => {
                let mut app = app.lock().await;
                app.transport_state = state;
            }
            None => return Ok(()),
        }
        let mut app = app.lock().await;
        terminal.draw(|f| ui(f, &mut app))?;
    }
}

fn ui(f: &mut Frame, app: &mut App) {
    // Main layout with margins for a cleaner look
    let main_layout = if app.search_mode {
        Layout::default()
            .direction(Direction::Vertical)
            .margin(1)
            .constraints([
                Constraint::Length(5), // Header section
                Constraint::Length(3), // Search bar section
                Constraint::Min(0),    // Table section
                Constraint::Length(3), // Footer/controls section
            ])
            .split(f.size())
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .margin(1)
            .constraints([
                Constraint::Length(5), // Header section
                Constraint::Min(0),    // Table section
                Constraint::Length(3), // Footer/controls section
            ])
            .split(f.size())
    };

    // Current track and state information
    let current_track = app
        .current_track
        .as_ref()
        .map_or("♪ No track playing", |t| t.title.as_str());
    let current_artist = app
        .current_track
        .as_ref()
        .and_then(|t| t.creator.as_ref())
        .map_or("", |s| s.as_str());

    let (state_symbol, _state_color, state_text) = match &app.transport_state {
        TransportState::Playing => ("▶", Color::Green, "Playing"),
        TransportState::PausedPlayback => ("⏸", Color::Yellow, "Paused"),
        TransportState::Stopped => ("⏹", Color::Red, "Stopped"),
        TransportState::Unspecified(s) => ("?", Color::Gray, s.as_str()),
        TransportState::Transitioning => ("⟳", Color::Cyan, "Transitioning"),
    };

    // Header with current playing info
    let header_content = format!(
        "🎵 {}\n👤 {}\n{} {}",
        current_track,
        if current_artist.is_empty() {
            "Unknown Artist"
        } else {
            current_artist
        },
        state_symbol,
        state_text
    );

    // Device selector info in top right
    let device_info = format!(
        "{} ({}/{})",
        app.device_name,
        app.current_device_index + 1,
        app.devices.len()
    );

    let header_area = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
        .split(main_layout[0]);

    let playing_block = Block::default()
        .borders(Borders::ALL)
        .border_set(border::ROUNDED)
        .padding(Padding::new(1, 1, 0, 0))
        .title("─Now Playing")
        .title_style(
            Style::default()
                .fg(Color::Magenta)
                .add_modifier(Modifier::BOLD),
        )
        .border_style(Style::default().fg(Color::Cyan));

    let playing_paragraph = Paragraph::new(header_content)
        .block(playing_block)
        .style(Style::default().fg(Color::White))
        .wrap(ratatui::widgets::Wrap { trim: true });

    f.render_widget(playing_paragraph, header_area[0]);

    let device_block = Block::default()
        .borders(Borders::ALL)
        .padding(Padding::new(1, 1, 0, 0))
        .border_set(border::ROUNDED)
        .title("─Device")
        .border_style(Style::default().fg(Color::Blue));

    let device_paragraph = Paragraph::new(device_info).block(device_block).style(
        Style::default()
            .fg(Color::Blue)
            .add_modifier(Modifier::BOLD),
    );

    f.render_widget(device_paragraph, header_area[1]);

    // Search bar (only shown when in search mode)
    if app.search_mode {
        f.render_widget(app.search_textarea.widget(), main_layout[1]);
    }

    let table_area_index = if app.search_mode { 2 } else { 1 };
    let table_area = main_layout[table_area_index];

    // Enhanced table styling
    let selected_style = Style::default()
        .bg(Color::Blue)
        .fg(Color::White)
        .add_modifier(Modifier::BOLD);

    let header_style = Style::default()
        .fg(Color::Yellow)
        .add_modifier(Modifier::BOLD);

    let header_cells = ["Song", "Artist"]
        .iter()
        .map(|h| Cell::from(*h).style(header_style));

    let header = Row::new(header_cells).height(1);

    // Alternating row colors for better readability
    let items_to_display = if app.search_mode {
        &app.filtered_items
    } else {
        &app.items
    };
    
    let rows = items_to_display.iter().enumerate().map(|(i, item)| {
        let style = if i % 2 == 0 {
            Style::default().fg(Color::White)
        } else {
            Style::default().fg(Color::Gray)
        };

        let cells = vec![
            Cell::from(format!("{}", item.name)).style(style),
            Cell::from(item.artist.clone()).style(style),
        ];
        Row::new(cells).height(1)
    });

    let table_block = Block::default()
        .borders(Borders::ALL)
        .border_set(border::ROUNDED)
        .title(if app.search_mode && !app.search_textarea.lines().join("").is_empty() {
            format!("─Music Library ({})", items_to_display.len())
        } else {
            "─Music Library".to_string()
        })
        .title_style(
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        )
        .border_style(Style::default().fg(Color::Green));

    let table = Table::new(rows)
        .header(header)
        .block(table_block)
        .highlight_style(selected_style)
        .highlight_symbol("▶ ")
        .widths(&[Constraint::Percentage(60), Constraint::Percentage(40)]);

    f.render_stateful_widget(table, table_area, &mut app.state);

    // Controls footer
    let controls_area_index = if app.search_mode { 3 } else { 2 };
    let controls_area = main_layout[controls_area_index];
    let controls = if app.search_mode {
        vec![
            "Space: Play/Pause",
            "Enter: Play Selected",
            "↑/↓: Navigate",
            "←/→: Seek",
            "Ctrl+←/→: Move Cursor",
            "ESC: Exit Search",
            "❌ Q: Quit",
        ]
    } else {
        vec![
            "Space: Play/Pause",
            "Enter: Play Selected",
            "←/→: Seek",
            "🔀 R: Random",
            "[/] : Switch Device",
            "🔄 P: Pull Library",
            "🔍 Ctrl+F: Search",
            "❌ Q: Quit",
        ]
    };

    let controls_text = controls.join(" │ ");

    let controls_block = Block::default()
        .borders(Borders::ALL)
        .border_set(border::ROUNDED)
        .title("─Controls")
        .padding(Padding::new(1, 1, 0, 0))
        .title_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .border_style(Style::default().fg(Color::Cyan));

    let controls_paragraph = Paragraph::new(controls_text)
        .block(controls_block)
        .style(Style::default().fg(Color::White))
        .wrap(ratatui::widgets::Wrap { trim: true });

    f.render_widget(controls_paragraph, controls_area);
}

async fn play_song(device: &SonosDevice, item: &LibraryItem) -> Result<()> {
    let url_prefix = "https://reitunes.blob.core.windows.net/music/";
    let filename_url_encoded = urlencoding::encode(&item.file_path);
    let url = format!("{}{}", url_prefix, filename_url_encoded);

    let mut metadata = TrackMetaData::default();
    metadata.title = item.name.clone();
    set_av_transport_uri_with_retry(device, &url, Some(metadata)).await?;
    play_with_retry(device).await?;
    Ok(())
}

async fn play_random_bookmark(device: &SonosDevice, library: &Library) -> Result<()> {
    if let Some((item_id, bookmark_id)) = library.random_bookmark() {
        if let Some(item) = library.items.get(&item_id) {
            if let Some(bookmark) = item.bookmarks.get(&bookmark_id) {
                stop_with_retry(device).await?;
                play_song(device, item).await?;
                seek_with_retry(
                    device,
                    sonos::av_transport::SeekRequest {
                        instance_id: 0,
                        unit: sonos::SeekMode::RelTime,
                        target: format!(
                            "{:02}:{:02}:{:02}",
                            bookmark.position.as_secs() / 3600,
                            (bookmark.position.as_secs() % 3600) / 60,
                            bookmark.position.as_secs() % 60
                        ),
                    },
                )
                .await?;
            }
        }
    }
    Ok(())
}
async fn av_transport_handler(
    mut device_rx: watch::Receiver<SonosDevice>,
    tx: mpsc::Sender<InputEvent>,
) {
    let mut current_device = device_rx.borrow().clone();
    let mut events = current_device
        .subscribe_av_transport()
        .await
        .expect("Failed to subscribe to AV transport");

    loop {
        tokio::select! {
            Ok(_) = device_rx.changed() => {
                current_device = device_rx.borrow().clone();
                events = current_device.subscribe_av_transport().await.expect("Failed to subscribe to AV transport");
            }
            Some(event) = events.recv() => {
                if let Some(last_change) = event.last_change {
                    if let Some(lcm) = last_change.0 {
                        let map = lcm.map;
                        if let Some(last_change) = map.get(&0) {
                            if let Some(xml) = &last_change.enqueued_transport_uri_meta_data {
                                if let Some(track_metadata) = &xml.0 {
                                    tx.send(InputEvent::TrackMetadataChanged(Some(track_metadata.clone()))).await.ok();
                                }
                            }
                            if let Some(transport_state) = &last_change.transport_state {
                                tx.send(InputEvent::TransportStateChanged(transport_state.clone())).await.ok();
                            }
                        }
                    }
                }
            }
            else => break,
        }
    }
}
