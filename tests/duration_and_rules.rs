use reitunes_workspace::{Event, EventWithMetadata, Library, SmartPlaylistRules};
use serde_json::json;
use uuid::Uuid;

#[test]
fn duration_survives_event_replay_and_is_cleared_when_audio_is_replaced() {
    let id = Uuid::new_v4();
    let mut library = Library::new();
    library.apply(&EventWithMetadata::new(id, Event::LibraryItemCreatedEvent {
        name: "Song".into(), artist: None, album: None, track_number: None, file_path: "one.mp3".into(),
    }).unwrap());
    assert_eq!(library.items[&id].duration_seconds, None);
    let event = EventWithMetadata::new(id, Event::LibraryItemDurationChangedEvent { seconds: 241.92 }).unwrap();
    let restored = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
    library.apply(&restored);
    assert_eq!(library.items[&id].duration_seconds, Some(241.92));
    library.apply(&EventWithMetadata::new(id, Event::LibraryItemFilePathChangedEvent { new_file_path: "two.mp3".into() }).unwrap());
    assert_eq!(library.items[&id].duration_seconds, None);
}

#[test]
fn smart_rules_round_trip_and_reject_invalid_or_excessive_expressions() {
    let mut value = json!({"added_within_days":null,"play_state":"any","favourites_only":false,
        "expression":{"type":"all","rules":[{"type":"duration","comparison":"lt","seconds":600},
            {"type":"any","rules":[{"type":"text","field":"artist","comparison":"contains","value":"Beck"},{"type":"favourite","value":true}]}]}});
    let rules: SmartPlaylistRules = serde_json::from_value(value.clone()).unwrap();
    assert!(rules.is_valid());
    let restored: SmartPlaylistRules = serde_json::from_str(&serde_json::to_string(&rules).unwrap()).unwrap();
    assert_eq!(rules, restored);
    value["expression"]["rules"][0]["seconds"] = json!(-10);
    assert!(!serde_json::from_value::<SmartPlaylistRules>(value.clone()).unwrap().is_valid());
    value["expression"] = json!({"type":"all","rules":[]});
    for _ in 0..6 { value["expression"] = json!({"type":"all","rules":[value["expression"].clone()]}); }
    assert!(!serde_json::from_value::<SmartPlaylistRules>(value).unwrap().is_valid());
}

#[test]
fn tag_rules_round_trip_and_validate_tag_names() {
    let mut value = json!({"added_within_days":null,"play_state":"any","favourites_only":false,
        "expression":{"type":"any","rules":[{"type":"tag","value":"indie-rock","present":true},
            {"type":"tag","value":"house","present":false},{"type":"has_tags","value":false}]}});
    let rules: SmartPlaylistRules = serde_json::from_value(value.clone()).unwrap();
    assert!(rules.is_valid());
    let restored: SmartPlaylistRules = serde_json::from_str(&serde_json::to_string(&rules).unwrap()).unwrap();
    assert_eq!(rules, restored);
    for invalid in ["".to_string(), "  ".to_string(), "x".repeat(61), "folk\u{0000}".to_string()] {
        value["expression"]["rules"][0]["value"] = json!(invalid);
        assert!(!serde_json::from_value::<SmartPlaylistRules>(value.clone()).unwrap().is_valid());
    }
}
