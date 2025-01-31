use anyhow::Result;
use crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::stream::StreamExt;
use ratatui::{
    backend::{Backend, CrosstermBackend},
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Cell, Row, Table, TableState},
    Frame, Terminal,
};
use sonos_player::{download_and_save_events, load_library_from_db, Library, LibraryItem};
use rusqlite::Connection;
use sonos::{av_transport::SeekRequest, SonosDevice, TrackMetaData, TransportState};
use std::{io, sync::Arc, time::Duration};
use tokio::{select, sync::{mpsc, Mutex, watch}};
use tracing::{info, warn};


use crate::retry::{pause_with_retry, play_with_retry, seek_with_retry, set_av_transport_uri_with_retry, stop_with_retry};

enum InputEvent {
    Input(KeyCode),
    Tick,
    TrackMetadataChanged(Option<TrackMetaData>),
    TransportStateChanged(TransportState),
}

struct App {
    conn: Connection,
    device: SonosDevice,
    device_name: String,
    items: Vec<LibraryItem>,
    state: TableState,
    current_track: Option<TrackMetaData>,
    transport_state: TransportState,
    devices: Vec<&'static str>,
    current_device_index: usize,
    library: Library,
}

pub async fn run_tui(library: Library, conn: Connection, devices: Vec<&'static str>) -> Result<()> {
    let initial_device = SonosDevice::for_room(devices[0]).await?;

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
                                if tx_clone.send(InputEvent::Input(key_event.code)).await.is_err() {
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
    let mut state = TableState::default();
    state.select(Some(0));
    let device_name = initial_device.name().await?;
    let app = Arc::new(Mutex::new(App {
        conn,
        device: initial_device.clone(),
        device_name,
        items,
        state,
        current_track: None,
        transport_state: TransportState::Stopped,
        devices,
        current_device_index: 0,
        library,
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
            Some(InputEvent::Input(key)) => {
                let mut app = app.lock().await;
                match key {
                    KeyCode::Char('q') => return Ok(()),
                    KeyCode::Down => {
                        let i = match app.state.selected() {
                            Some(i) => {
                                if i >= app.items.len() - 1 {
                                    0
                                } else {
                                    i + 1
                                }
                            }
                            None => 0,
                        };
                        app.state.select(Some(i));
                    }
                    KeyCode::Up => {
                        let i = match app.state.selected() {
                            Some(i) => {
                                if i == 0 {
                                    app.items.len() - 1
                                } else {
                                    i - 1
                                }
                            }
                            None => 0,
                        };
                        app.state.select(Some(i));
                    }
                    KeyCode::Right => {
                        // Seek forward by 30 seconds
                        let _ = seek_with_retry(&app.device, SeekRequest { instance_id: 0, unit: sonos::SeekMode::TimeDelta, target: "+00:00:30".into() }).await;
                    }
                    KeyCode::Left => {
                        // Seek backward by 30 seconds
                        let _ = seek_with_retry(&app.device, SeekRequest { instance_id: 0, unit: sonos::SeekMode::TimeDelta, target: "-00:00:30".into() }).await;
                    }
                    KeyCode::Enter => {
                        if let Some(selected) = app.state.selected() {
                            let item = &app.items[selected];
                            let _ = play_song(&app.device, item).await;
                        }
                    }
                    KeyCode::Char(' ') => {
                        match app.transport_state {
                            TransportState::Stopped => play_with_retry(&app.device).await?,
                            TransportState::Playing => pause_with_retry(&app.device).await?,
                            TransportState::PausedPlayback => play_with_retry(&app.device).await?,
                            _ => {}
                        }
                    }
                    KeyCode::Char('[') => {
                        app.current_device_index = (app.current_device_index + app.devices.len() - 1) % app.devices.len();
                        let new_device = SonosDevice::for_room(app.devices[app.current_device_index]).await?;
                        app.device = new_device.clone();
                        app.device_name = app.device.name().await?;
                        app.current_track = None;
                        app.transport_state = TransportState::Unspecified("Unknown".into());
                        device_tx.send(new_device).ok();
                    }
                    KeyCode::Char(']') => {
                        app.current_device_index = (app.current_device_index + 1) % app.devices.len();
                        let new_device = SonosDevice::for_room(app.devices[app.current_device_index]).await?;
                        app.device = new_device.clone();
                        app.device_name = app.device.name().await?;
                        app.current_track = None;
                        app.transport_state = TransportState::Unspecified("Unknown".into());
                        device_tx.send(new_device).ok();
                    }
                    KeyCode::Char('r') => {
                        play_random_bookmark(&app.device, &app.library).await?;
                    }
                    KeyCode::Char('p') => {
                        download_and_save_events(&mut app.conn).await?;
                        app.library = load_library_from_db(&app.conn)?;
                        let mut items: Vec<LibraryItem> = app.library.items.values().cloned().collect();
                        items.sort_by(|a, b| b.created_time_utc.cmp(&a.created_time_utc));
                        app.items = items;
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
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(0)
        .constraints([Constraint::Length(4), Constraint::Percentage(100)].as_ref())
        .split(f.size());

    let current_track = app.current_track.as_ref().map_or("Unknown", |t| t.title.as_str());
    let transport_state = match &app.transport_state {
        TransportState::Playing => "Playing",
        TransportState::PausedPlayback => "Paused",
        TransportState::Stopped => "Stopped",
        TransportState::Unspecified(s) => s.as_str(),
        TransportState::Transitioning => "Transitioning",
    };
    let info = vec![
        format!("Track: {}", current_track),
        format!("State: {}", transport_state),
    ];

    let info_paragraph = ratatui::widgets::Paragraph::new(info.join("\n"))
        .block(Block::default()
            .borders(Borders::ALL)
            .title(format!("Sonos ({})", app.device_name)));
    f.render_widget(info_paragraph, chunks[0]);

    let selected_style = Style::default()
        .add_modifier(Modifier::REVERSED);
    let header_cells = ["Name", "Artist"]
        .iter()
        .map(|h| Cell::from(*h).style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD)));
    let header = Row::new(header_cells)
        .height(1);
    let rows = app.items.iter().map(|item| {
        let cells = vec![
            Cell::from(item.name.clone()),
            Cell::from(item.artist.clone()),
        ];
        Row::new(cells).height(1).bottom_margin(0)
    });

    let t = Table::new(rows)
        .header(header)
        .block(Block::default().borders(Borders::ALL).title("Songs"))
        .highlight_style(selected_style)
        .highlight_symbol(">> ")
        .widths(&[
            Constraint::Percentage(60),
            Constraint::Percentage(40),
        ]);

    f.render_stateful_widget(t, chunks[1], &mut app.state);
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
                seek_with_retry(device, sonos::av_transport::SeekRequest {
                    instance_id: 0,
                    unit: sonos::SeekMode::RelTime,
                    target: format!("{:02}:{:02}:{:02}", 
                        bookmark.position.as_secs() / 3600,
                        (bookmark.position.as_secs() % 3600) / 60,
                        bookmark.position.as_secs() % 60
                    ),
                }).await?;
            }
        }
    }
    Ok(())
}
async fn av_transport_handler(mut device_rx: watch::Receiver<SonosDevice>, tx: mpsc::Sender<InputEvent>) {
    let mut current_device = device_rx.borrow().clone();
    let mut events = current_device.subscribe_av_transport().await.expect("Failed to subscribe to AV transport");

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
