use crate::retry::{
    pause_with_retry, play_with_retry, seek_with_retry, set_av_transport_uri_with_retry,
    stop_with_retry,
};
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
use reitunes_workspace::{
    download_and_save_events, load_library_from_db, Bookmark, Library, LibraryItem,
};
use rusqlite::Connection;
use sonos::{av_transport::SeekRequest, SonosDevice, TrackMetaData, TransportState};
use std::{io, sync::Arc, time::Duration};
use tokio::{
    select,
    sync::{mpsc, watch, Mutex},
};
use tracing::{info, warn};
use tui_textarea::{Input, TextArea};

enum InputEvent {
    Input(KeyEvent),
    Tick,
    TrackMetadataChanged(Option<TrackMetaData>),
    TransportStateChanged(TransportState),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    Library,
    Bookmarks,
    Search,
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
    search_active: bool,
    focus: Focus,
    bookmark_state: TableState,
}

impl App {
    fn update_filtered_items(&mut self) {
        let search_query = self.search_textarea.lines().join(" ");
        if self.is_search_mode() && !search_query.is_empty() {
            let query = search_query.to_lowercase();
            self.filtered_items = self
                .items
                .iter()
                .filter(|item| {
                    item.name.to_lowercase().contains(&query)
                        || item.artist.to_lowercase().contains(&query)
                        || item.album.to_lowercase().contains(&query)
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
        self.sync_bookmark_selection();
    }

    fn selected_items(&self) -> &Vec<LibraryItem> {
        if self.is_search_mode() {
            &self.filtered_items
        } else {
            &self.items
        }
    }

    fn selected_item(&self) -> Option<&LibraryItem> {
        let items = self.selected_items();
        self.state
            .selected()
            .and_then(|selected| items.get(selected))
    }

    fn sync_bookmark_selection(&mut self) {
        if let Some(item) = self.selected_item() {
            if item.bookmarks.is_empty() {
                self.bookmark_state.select(None);
            } else {
                let desired = self
                    .bookmark_state
                    .selected()
                    .unwrap_or(0)
                    .min(item.bookmarks.len() - 1);
                self.bookmark_state.select(Some(desired));
            }
        } else {
            self.bookmark_state.select(None);
        }
    }

    fn bookmarks_for_selected_item(&self) -> Vec<Bookmark> {
        self.selected_item()
            .map(|item| item.bookmarks.values().cloned().collect())
            .unwrap_or_default()
    }

    fn selected_bookmark(&self) -> Option<(&LibraryItem, &Bookmark)> {
        let item = self.selected_item()?;
        let bookmark_index = self.bookmark_state.selected()?;
        item.bookmarks
            .get_index(bookmark_index)
            .map(|(_, bookmark)| (item, bookmark))
    }

    fn is_search_mode(&self) -> bool {
        self.search_active
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
            .border_style(Style::default().fg(Color::Yellow)),
    );
    search_textarea.set_placeholder_text("Type to search songs by name, artist, or album...");

    let mut app_instance = App {
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
        search_active: false,
        focus: Focus::Library,
        bookmark_state: TableState::default(),
    };
    app_instance.sync_bookmark_selection();

    let app = Arc::new(Mutex::new(app_instance));

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
                        if !app.search_active {
                            app.search_active = true;
                            app.search_textarea.select_all();
                            app.search_textarea.delete_line_by_head();
                            app.update_filtered_items();
                        } else {
                            app.search_textarea.select_all();
                        }
                        app.focus = Focus::Search;
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
                    } => match app.focus {
                        Focus::Search => {
                            app.focus = Focus::Library;
                            app.search_active = false;
                            app.search_textarea.select_all();
                            app.search_textarea.delete_line_by_head();
                            app.update_filtered_items();
                        }
                        Focus::Bookmarks => {
                            app.focus = Focus::Library;
                        }
                        Focus::Library => {
                            if app.search_active {
                                app.search_active = false;
                                app.search_textarea.select_all();
                                app.search_textarea.delete_line_by_head();
                                app.update_filtered_items();
                            }
                        }
                    },
                    KeyEvent {
                        code: KeyCode::Char('b'),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if !matches!(app.focus, Focus::Search) => {
                        if matches!(app.focus, Focus::Bookmarks) {
                            app.focus = Focus::Library;
                        } else {
                            app.focus = Focus::Bookmarks;
                            app.sync_bookmark_selection();
                        }
                    }
                    KeyEvent {
                        code: KeyCode::Tab, ..
                    } => {
                        app.focus = match app.focus {
                            Focus::Search => Focus::Library,
                            Focus::Library => Focus::Bookmarks,
                            Focus::Bookmarks => {
                                if app.search_active {
                                    Focus::Search
                                } else {
                                    Focus::Library
                                }
                            }
                        };
                        if matches!(app.focus, Focus::Bookmarks) {
                            app.sync_bookmark_selection();
                        }
                    }
                    KeyEvent {
                        code: KeyCode::BackTab,
                        ..
                    } => {
                        app.focus = match app.focus {
                            Focus::Search => {
                                if app.search_active {
                                    Focus::Bookmarks
                                } else {
                                    Focus::Library
                                }
                            }
                            Focus::Bookmarks => Focus::Library,
                            Focus::Library => {
                                if app.search_active {
                                    Focus::Search
                                } else {
                                    Focus::Bookmarks
                                }
                            }
                        };
                        if matches!(app.focus, Focus::Bookmarks) {
                            app.sync_bookmark_selection();
                        }
                    }
                    // Handle typing in search mode - only printable characters and basic editing keys
                    KeyEvent {
                        code: KeyCode::Char(_),
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    KeyEvent {
                        code: KeyCode::Backspace,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    KeyEvent {
                        code: KeyCode::Delete,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                        app.update_filtered_items();
                    }
                    // Text editing keys for search mode
                    KeyEvent {
                        code: KeyCode::Home,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    KeyEvent {
                        code: KeyCode::End,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    // Use Ctrl+Left/Right for cursor movement in search mode
                    KeyEvent {
                        code: KeyCode::Left,
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    KeyEvent {
                        code: KeyCode::Right,
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    // Ctrl+A to select all in search mode
                    KeyEvent {
                        code: KeyCode::Char('a'),
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
                        let input = Input::from(key_event);
                        app.search_textarea.input(input);
                    }
                    // Ctrl+U to clear line in search mode
                    KeyEvent {
                        code: KeyCode::Char('u'),
                        modifiers: KeyModifiers::CONTROL,
                        ..
                    } if matches!(app.focus, Focus::Search) => {
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
                        if matches!(app.focus, Focus::Bookmarks) {
                            let bookmarks = app.bookmarks_for_selected_item();
                            let len = bookmarks.len();
                            if len > 0 {
                                let i = match app.bookmark_state.selected() {
                                    Some(i) => {
                                        if i >= len - 1 {
                                            0
                                        } else {
                                            i + 1
                                        }
                                    }
                                    None => 0,
                                };
                                app.bookmark_state.select(Some(i));
                            }
                        } else {
                            let len = if app.is_search_mode() {
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
                                app.sync_bookmark_selection();
                            }
                        }
                    }
                    KeyEvent {
                        code: KeyCode::Up,
                        modifiers: KeyModifiers::NONE,
                        ..
                    } => {
                        if matches!(app.focus, Focus::Bookmarks) {
                            let bookmarks = app.bookmarks_for_selected_item();
                            let len = bookmarks.len();
                            if len > 0 {
                                let i = match app.bookmark_state.selected() {
                                    Some(0) | None => len - 1,
                                    Some(i) => i - 1,
                                };
                                app.bookmark_state.select(Some(i));
                            }
                        } else {
                            let len = if app.is_search_mode() {
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
                                app.sync_bookmark_selection();
                            }
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
                        if matches!(app.focus, Focus::Bookmarks) {
                            if let Some((item, bookmark)) = app.selected_bookmark() {
                                let _ = play_bookmark(&app.device, item, bookmark).await;
                            }
                        } else if let Some(selected) = app.state.selected() {
                            let items = if app.is_search_mode() {
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
                        app.sync_bookmark_selection();
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
    let main_layout = if app.is_search_mode() {
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

    // Search bar (highlight when focused)
    if app.search_active {
        let (border_color, title_suffix) = if matches!(app.focus, Focus::Search) {
            (Color::Yellow, " ⦿")
        } else {
            (Color::DarkGray, "")
        };

        let search_block = Block::default()
            .borders(Borders::ALL)
            .border_set(border::ROUNDED)
            .title(format!("─Search{}", title_suffix))
            .title_style(
                Style::default()
                    .fg(border_color)
                    .add_modifier(Modifier::BOLD),
            )
            .border_style(Style::default().fg(border_color))
            .padding(Padding::new(1, 1, 0, 0));

        app.search_textarea.set_block(search_block);
        f.render_widget(app.search_textarea.widget(), main_layout[1]);
    }

    let table_area_index = if app.is_search_mode() { 2 } else { 1 };
    let library_area = main_layout[table_area_index];
    let areas = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(10), Constraint::Length(14)])
        .split(library_area);
    let table_area = areas[0];
    let bookmark_area = areas[1];

    // Enhanced table styling
    let selected_style = if matches!(app.focus, Focus::Library) {
        Style::default()
            .bg(Color::Blue)
            .fg(Color::White)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
            .fg(Color::LightBlue)
            .add_modifier(Modifier::DIM)
    };

    let header_style = Style::default()
        .fg(Color::Yellow)
        .add_modifier(Modifier::BOLD);

    let header_cells = ["Song", "Artist"]
        .iter()
        .map(|h| Cell::from(*h).style(header_style));

    let header = Row::new(header_cells).height(1);

    // Alternating row colors for better readability
    let items_to_display = if app.is_search_mode() {
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
            Cell::from(item.name.to_string()).style(style),
            Cell::from(item.artist.clone()).style(style),
        ];
        Row::new(cells).height(1)
    });

    let table_block = Block::default()
        .borders(Borders::ALL)
        .border_set(border::ROUNDED)
        .title(
            if app.is_search_mode() && !app.search_textarea.lines().join("").is_empty() {
                format!("─Music Library ({})", items_to_display.len())
            } else {
                "─Music Library".to_string()
            },
        )
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

    let border_color = if matches!(app.focus, Focus::Bookmarks) {
        Color::Magenta
    } else {
        Color::DarkGray
    };

    let bookmark_title = app
        .selected_item()
        .map(|item| format!("─Bookmarks · {}", item.name))
        .unwrap_or_else(|| "─Bookmarks".to_string());

    let bookmarks = app.bookmarks_for_selected_item();

    if bookmarks.is_empty() {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_set(border::ROUNDED)
            .title(bookmark_title)
            .title_style(
                Style::default()
                    .fg(border_color)
                    .add_modifier(Modifier::BOLD),
            )
            .border_style(Style::default().fg(border_color))
            .padding(Padding::new(1, 1, 0, 0));
        let paragraph = Paragraph::new("")
            .block(block)
            .style(Style::default().fg(Color::Gray))
            .wrap(ratatui::widgets::Wrap { trim: true });
        f.render_widget(paragraph, bookmark_area);
    } else {
        let rows = bookmarks.iter().enumerate().map(|(i, bookmark)| {
            let base_style = if i % 2 == 0 {
                Style::default().fg(Color::White)
            } else {
                Style::default().fg(Color::Gray)
            };
            let time_cell = Cell::from(format_duration(&bookmark.position)).style(base_style);
            Row::new(vec![time_cell]).height(1)
        });

        let highlight_style = if matches!(app.focus, Focus::Bookmarks) {
            Style::default()
                .bg(Color::Magenta)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
                .fg(border_color)
                .add_modifier(Modifier::BOLD)
        };

        let table_block = Block::default()
            .borders(Borders::ALL)
            .border_set(border::ROUNDED)
            .title(bookmark_title)
            .title_style(
                Style::default()
                    .fg(border_color)
                    .add_modifier(Modifier::BOLD),
            )
            .border_style(Style::default().fg(border_color));

        let bookmark_table = Table::new(rows)
            .block(table_block)
            .highlight_style(highlight_style)
            .highlight_symbol("▶ ")
            .widths(&[Constraint::Percentage(100)]);

        f.render_stateful_widget(bookmark_table, bookmark_area, &mut app.bookmark_state);
    }

    // Controls footer
    let controls_area_index = if app.is_search_mode() { 3 } else { 2 };
    let controls_area = main_layout[controls_area_index];
    let mut controls = if app.is_search_mode() {
        vec![
            "Space: Play/Pause",
            "Enter: Play Selected",
            "↑/↓: Navigate",
            "←/→: Seek",
            "Ctrl+←/→: Move Cursor",
            "Tab: Next Focus",
            "Shift+Tab: Prev Focus",
            "ESC: Exit Search",
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
            "Tab: Next Focus",
            "Shift+Tab: Prev Focus",
        ]
    };

    if matches!(app.focus, Focus::Bookmarks) {
        controls.push("B/Esc: Back to Library");
        controls.push("Enter: Play Bookmark");
    } else {
        controls.push("B: Focus Bookmarks");
    }
    controls.push("❌ Q: Quit");

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

fn format_duration(duration: &Duration) -> String {
    let total_seconds = duration.as_secs();
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

/// Get the storage base URL from environment or default
fn storage_base_url() -> String {
    std::env::var("STORAGE_BASE_URL")
        .unwrap_or_else(|_| "https://reitunes.blob.core.windows.net/music".to_string())
}

async fn play_song(device: &SonosDevice, item: &LibraryItem) -> Result<()> {
    let base_url = storage_base_url();
    let filename_url_encoded = urlencoding::encode(&item.file_path);
    let url = format!("{}/{}", base_url, filename_url_encoded);

    let metadata = TrackMetaData { title: item.name.clone(), ..Default::default() };
    set_av_transport_uri_with_retry(device, &url, Some(metadata)).await?;
    play_with_retry(device).await?;
    Ok(())
}

async fn play_bookmark(
    device: &SonosDevice,
    item: &LibraryItem,
    bookmark: &Bookmark,
) -> Result<()> {
    stop_with_retry(device).await?;
    play_song(device, item).await?;
    seek_with_retry(
        device,
        sonos::av_transport::SeekRequest {
            instance_id: 0,
            unit: sonos::SeekMode::RelTime,
            target: format_duration(&bookmark.position),
        },
    )
    .await?;
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
                        target: format_duration(&bookmark.position),
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
