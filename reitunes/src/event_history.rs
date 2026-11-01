//! Read-only view of the event log: what each event did, worked out by replaying the log.
//!
//! The log only records intent ("artist changed to X"), so showing the old value means
//! rebuilding the state as it was. A replay is quick enough for an occasionally opened
//! page, and it doubles as a check that the state in memory is what the log says it is.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::Query;
use serde_json::{Map, Value};

use crate::*;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
/// Enough to go looking; if more than this many items drifted, the count isn't the story.
const MAX_REPORTED_DRIFT: usize = 20;

#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    /// Only events older than this one. Pass the previous response's `next_before`.
    before: Option<Uuid>,
    limit: Option<usize>,
    event_type: Option<String>,
    aggregate: Option<Uuid>,
    /// Matches the item or playlist's latest name, or its ID.
    q: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventHistory {
    total: usize,
    matching: usize,
    /// Over the whole log, so the filter menu doesn't shrink as filters apply.
    type_counts: BTreeMap<String, usize>,
    replay: ReplayCheck,
    events: Vec<HistoryEvent>,
    next_before: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct ReplayCheck {
    elapsed_ms: f64,
    matches_live: bool,
    /// Items and playlists whose replayed state differs from the one in memory.
    drifted: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
struct HistoryEvent {
    id: Uuid,
    aggregate_id: Uuid,
    aggregate_type: &'static str,
    /// The name at the time of this event.
    aggregate_name: Option<String>,
    created_time_utc: jiff::civil::DateTime,
    machine_name: String,
    event_type: String,
    payload: Value,
    /// Empty when replaying the event changed nothing.
    changes: Vec<FieldChange>,
}

#[derive(Debug, PartialEq, Serialize)]
struct FieldChange {
    field: String,
    before: Value,
    after: Value,
}

enum Stored {
    Item(EventWithMetadata),
    Playlist(PlaylistEventWithMetadata),
}

impl Stored {
    fn id(&self) -> Uuid {
        match self { Self::Item(event) => event.id, Self::Playlist(event) => event.id }
    }
    fn aggregate_id(&self) -> Uuid {
        match self { Self::Item(event) => event.aggregate_id, Self::Playlist(event) => event.aggregate_id }
    }
    fn created(&self) -> jiff::civil::DateTime {
        match self { Self::Item(event) => event.created_time_utc, Self::Playlist(event) => event.created_time_utc }
    }
    fn payload(&self) -> Result<Value> {
        Ok(match self {
            Self::Item(event) => serde_json::to_value(&event.event)?,
            Self::Playlist(event) => serde_json::to_value(&event.event)?,
        })
    }
    fn new_name(&self) -> Option<&str> {
        match self {
            Self::Item(EventWithMetadata { event: Event::LibraryItemCreatedEvent { name, .. }, .. })
            | Self::Item(EventWithMetadata { event: Event::LibraryItemNameChangedEvent { new_name: name }, .. })
            | Self::Playlist(PlaylistEventWithMetadata { event: PlaylistEvent::PlaylistCreatedEvent { name, .. }, .. })
            | Self::Playlist(PlaylistEventWithMetadata { event: PlaylistEvent::PlaylistRenamedEvent { new_name: name }, .. }) => Some(name),
            _ => None,
        }
    }
}

fn event_type(payload: &Value) -> String {
    payload["$type"].as_str().unwrap_or("Unknown").to_string()
}

/// The fields that differ, with nested objects (bookmarks, playlist items) flattened into
/// paths. Missing and null count as the same thing.
fn diff(before: &Value, after: &Value) -> Vec<FieldChange> {
    fn walk(path: &str, before: Option<&Value>, after: Option<&Value>, out: &mut Vec<FieldChange>) {
        let (before, after) = (before.unwrap_or(&Value::Null), after.unwrap_or(&Value::Null));
        if before == after { return; }
        let empty = Map::new();
        let as_fields = |value: &'_ Value| value.is_object() || value.is_null();
        if (before.is_object() || after.is_object()) && as_fields(before) && as_fields(after) {
            let (old, new) = (before.as_object().unwrap_or(&empty), after.as_object().unwrap_or(&empty));
            for key in old.keys().chain(new.keys().filter(|key| !old.contains_key(*key))) {
                let child = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                walk(&child, old.get(key), new.get(key), out);
            }
        } else {
            out.push(FieldChange { field: path.to_string(), before: before.clone(), after: after.clone() });
        }
    }
    let mut out = Vec::new();
    walk("", Some(before), Some(after), &mut out);
    out
}

/// A rebuild of every event, keeping the details only for the requested page.
fn build(
    conn: &rusqlite::Connection,
    live_items: &HashMap<Uuid, LibraryItem>,
    live_playlists: &indexmap::IndexMap<Uuid, Playlist>,
    query: &HistoryQuery,
) -> Result<EventHistory> {
    let start = std::time::Instant::now();
    // Each log is already in replay order and a stable sort keeps it that way, so merging
    // them for display can't change what either one rebuilds to.
    let mut log: Vec<Stored> = load_all_events_from_db(conn)?.into_iter().map(Stored::Item)
        .chain(load_all_playlist_events_from_db(conn)?.into_iter().map(Stored::Playlist))
        .collect();
    log.sort_by_key(Stored::created);

    let mut latest_names: HashMap<Uuid, &str> = HashMap::new();
    for event in &log {
        if let Some(name) = event.new_name() { latest_names.insert(event.aggregate_id(), name); }
    }

    let needle = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(str::to_lowercase);
    let wanted_type = query.event_type.as_deref().filter(|kind| !kind.is_empty());
    let mut type_counts = BTreeMap::new();
    let mut matching = Vec::new();
    for (index, event) in log.iter().enumerate() {
        let kind = event_type(&event.payload()?);
        let matches_type = wanted_type.is_none_or(|wanted| wanted == kind);
        *type_counts.entry(kind).or_insert(0) += 1;
        let id = event.aggregate_id();
        if matches_type
            && query.aggregate.is_none_or(|aggregate| aggregate == id)
            && needle.as_ref().is_none_or(|needle| {
                id.to_string().contains(needle.as_str())
                    || latest_names.get(&id).is_some_and(|name| name.to_lowercase().contains(needle.as_str()))
            })
        {
            matching.push(index);
        }
    }

    let end = query.before
        .and_then(|before| matching.iter().position(|&index| log[index].id() == before))
        .unwrap_or(matching.len());
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let first = end.saturating_sub(limit);
    let page: HashSet<usize> = matching[first..end].iter().copied().collect();
    let next_before = (first > 0).then(|| log[matching[first]].id());

    let mut items = Library::new();
    let mut playlists = PlaylistStore::new();
    let mut events = Vec::with_capacity(page.len());
    for (index, event) in log.iter().enumerate() {
        let id = event.aggregate_id();
        let snapshot = |items: &Library, playlists: &PlaylistStore| -> Result<Value> {
            Ok(match event {
                Stored::Item(_) => serde_json::to_value(items.items.get(&id))?,
                Stored::Playlist(_) => serde_json::to_value(playlists.playlists.get(&id))?,
            })
        };
        let before = page.contains(&index).then(|| snapshot(&items, &playlists)).transpose()?;
        match event {
            Stored::Item(event) => items.apply(event),
            Stored::Playlist(event) => playlists.apply(event),
        }
        let Some(before) = before else { continue };
        let after = snapshot(&items, &playlists)?;
        let name = [&after, &before].iter().find_map(|state| state["name"].as_str()).map(String::from);
        let payload = event.payload()?;
        let (aggregate_type, machine_name) = match event {
            Stored::Item(event) => ("LibraryItem", &event.machine_name),
            Stored::Playlist(event) => ("Playlist", &event.machine_name),
        };
        events.push(HistoryEvent {
            id: event.id(),
            aggregate_id: id,
            aggregate_type,
            aggregate_name: name,
            created_time_utc: event.created(),
            machine_name: machine_name.clone(),
            event_type: event_type(&payload),
            payload,
            // An item's identity is already on the row; don't list it as a change.
            changes: diff(&before, &after).into_iter()
                .filter(|change| !matches!(change.field.as_str(), "id" | "created_time_utc"))
                .collect(),
        });
    }
    events.reverse();

    let item_ids = items.items.keys().chain(live_items.keys()).collect::<HashSet<_>>();
    let playlist_ids = playlists.playlists.keys().chain(live_playlists.keys()).collect::<HashSet<_>>();
    let mut drifted: Vec<Uuid> = item_ids.into_iter().filter(|id| items.items.get(*id) != live_items.get(*id))
        .chain(playlist_ids.into_iter().filter(|id| playlists.playlists.get(*id) != live_playlists.get(*id)))
        .copied().collect();
    let matches_live = drifted.is_empty();
    if !matches_live { warn!(count = drifted.len(), "Replayed events differ from the state in memory"); }
    drifted.truncate(MAX_REPORTED_DRIFT);

    Ok(EventHistory {
        total: log.len(),
        matching: matching.len(),
        type_counts,
        replay: ReplayCheck { elapsed_ms: start.elapsed().as_secs_f64() * 1000.0, matches_live, drifted },
        events,
        next_before,
    })
}

pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> Result<impl IntoResponse, AppError> {
    // Writers hold these locks across their database write, so nothing can land between
    // reading the log and comparing it with memory. Readers aren't held up.
    let items = state.library.clone().read_owned().await;
    let playlists = state.playlists.clone().read_owned().await;
    let history = tokio::task::spawn_blocking(move || {
        build(&*DB.get()?, &items.items, &playlists.playlists, &query)
    }).await??;
    Ok(Json(history))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn database() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../schema.sql")).unwrap();
        conn
    }

    fn created(name: &str) -> Event {
        Event::LibraryItemCreatedEvent {
            name: name.into(), artist: None, album: None, track_number: None, file_path: format!("{name}.mp3"),
        }
    }

    fn save(conn: &rusqlite::Connection, id: Uuid, event: Event, library: &mut Library) -> Uuid {
        let event = EventWithMetadata::new(id, event).unwrap();
        save_event_to_db(conn, &event).unwrap();
        library.apply(&event);
        event.id
    }

    fn history(conn: &rusqlite::Connection, library: &Library, query: HistoryQuery) -> EventHistory {
        build(conn, &library.items, &Default::default(), &query).unwrap()
    }

    #[test]
    fn diff_flattens_nested_objects_and_treats_missing_as_null() {
        let before = json!({ "name": "Old", "artist": "Same", "bookmarks": { "a": { "position": 1.0 } }, "album": null });
        let after = json!({ "name": "New", "artist": "Same", "bookmarks": { "a": { "position": 2.0 }, "b": { "position": 3.0 } } });
        assert_eq!(diff(&before, &after), vec![
            FieldChange { field: "bookmarks.a.position".into(), before: json!(1.0), after: json!(2.0) },
            FieldChange { field: "bookmarks.b.position".into(), before: Value::Null, after: json!(3.0) },
            FieldChange { field: "name".into(), before: json!("Old"), after: json!("New") },
        ]);
        assert!(diff(&before, &before).is_empty());
    }

    #[test]
    fn each_event_shows_the_old_and_new_values() {
        let conn = database();
        let mut library = Library::new();
        let id = Uuid::new_v4();
        save(&conn, id, created("First"), &mut library);
        save(&conn, id, Event::LibraryItemNameChangedEvent { new_name: "Second".into() }, &mut library);
        save(&conn, id, Event::LibraryItemPlayedEvent, &mut library);

        let result = history(&conn, &library, HistoryQuery::default());
        assert_eq!((result.total, result.matching), (3, 3));
        assert!(result.replay.matches_live);
        let [played, renamed, first] = &result.events[..] else { panic!("expected newest first") };
        assert_eq!(played.changes, vec![FieldChange { field: "play_count".into(), before: json!(0), after: json!(1) }]);
        assert_eq!(renamed.changes, vec![FieldChange { field: "name".into(), before: json!("First"), after: json!("Second") }]);
        assert_eq!(renamed.aggregate_name.as_deref(), Some("Second"));
        assert_eq!(first.event_type, "LibraryItemCreatedEvent");
        assert!(first.changes.iter().any(|change| change.field == "file_path" && change.after == "First.mp3"));
    }

    #[test]
    fn events_that_change_nothing_have_no_changes_and_deleted_items_keep_their_name() {
        let conn = database();
        let mut library = Library::new();
        let id = Uuid::new_v4();
        save(&conn, id, created("Song"), &mut library);
        save(&conn, id, Event::LibraryItemNameChangedEvent { new_name: "Song".into() }, &mut library);
        save(&conn, id, Event::LibraryItemDeletedEvent, &mut library);
        save(&conn, id, Event::LibraryItemPlayedEvent, &mut library);

        let result = history(&conn, &library, HistoryQuery::default());
        let [played_after_delete, deleted, same_name, _] = &result.events[..] else { panic!() };
        assert!(played_after_delete.changes.is_empty());
        assert_eq!(deleted.aggregate_name.as_deref(), Some("Song"));
        assert!(deleted.changes.iter().any(|change| change.field == "name" && change.after.is_null()));
        assert!(same_name.changes.is_empty());
    }

    #[test]
    fn pages_filter_and_keep_counts_for_the_whole_log() {
        let conn = database();
        let mut library = Library::new();
        let (song, other) = (Uuid::new_v4(), Uuid::new_v4());
        save(&conn, song, created("Findable"), &mut library);
        save(&conn, other, created("Other"), &mut library);
        let mut plays = Vec::new();
        for _ in 0..5 { plays.push(save(&conn, song, Event::LibraryItemPlayedEvent, &mut library)); }

        let page = history(&conn, &library, HistoryQuery { limit: Some(2), ..Default::default() });
        assert_eq!(page.events.iter().map(|event| event.id).collect::<Vec<_>>(), vec![plays[4], plays[3]]);
        assert_eq!(page.next_before, Some(plays[3]));
        let next = history(&conn, &library, HistoryQuery { limit: Some(2), before: page.next_before, ..Default::default() });
        assert_eq!(next.events.iter().map(|event| event.id).collect::<Vec<_>>(), vec![plays[2], plays[1]]);

        let played = history(&conn, &library, HistoryQuery { event_type: Some("LibraryItemCreatedEvent".into()), ..Default::default() });
        assert_eq!(played.matching, 2);
        assert_eq!(played.type_counts["LibraryItemPlayedEvent"], 5);
        assert!(played.next_before.is_none());

        let by_name = history(&conn, &library, HistoryQuery { q: Some("FINDABLE".into()), ..Default::default() });
        assert_eq!(by_name.matching, 6);
        let by_id = history(&conn, &library, HistoryQuery { aggregate: Some(other), ..Default::default() });
        assert_eq!(by_id.matching, 1);
    }

    #[test]
    fn reports_when_memory_has_drifted_from_the_log() {
        let conn = database();
        let mut library = Library::new();
        let id = Uuid::new_v4();
        save(&conn, id, created("Song"), &mut library);
        library.items.get_mut(&id).unwrap().play_count = 99;

        let result = history(&conn, &library, HistoryQuery::default());
        assert!(!result.replay.matches_live);
        assert_eq!(result.replay.drifted, vec![id]);
    }

    #[test]
    fn playlist_events_are_merged_in_and_replayed() {
        let conn = database();
        let mut library = Library::new();
        let song = Uuid::new_v4();
        save(&conn, song, created("Song"), &mut library);
        let playlist = Uuid::new_v4();
        let mut live = PlaylistStore::new();
        for event in [
            PlaylistEvent::PlaylistCreatedEvent { name: "Mix".into(), smart_rules: None },
            PlaylistEvent::PlaylistItemAddedEvent { library_item_id: song, position: 0 },
        ] {
            let event = PlaylistEventWithMetadata::new(playlist, event).unwrap();
            save_playlist_event_to_db(&conn, &event).unwrap();
            live.apply(&event);
        }
        std::thread::sleep(Duration::from_millis(1));
        save(&conn, song, Event::LibraryItemPlayedEvent, &mut library);

        let result = build(&conn, &library.items, &live.playlists, &HistoryQuery::default()).unwrap();
        assert!(result.replay.matches_live);
        assert_eq!(result.events.len(), 4);
        assert_eq!(result.events[0].aggregate_type, "LibraryItem");
        let added = &result.events[1];
        assert_eq!((added.aggregate_type, added.aggregate_name.as_deref()), ("Playlist", Some("Mix")));
        assert!(added.changes[0].field.starts_with("items."));
    }
}
