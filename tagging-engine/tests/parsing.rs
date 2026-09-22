use serde_json::{json, Value};
use tagging_engine::{Input, Research};

fn research() -> Research {
    Research::new(&[Input {
        id: "t01".into(),
        name: "Floating Points with Hikaru Utada 270726".into(),
        artist: "Floating Points, Hikaru Utada".into(),
        album: String::new(),
        musicbrainz: json!({}),
    }])
    .unwrap()
}

fn answer(basis: &str) -> Value {
    json!({"items":[{
        "id":"t01",
        "tags":[{
            "tag":"dj mix", "basis":basis, "confidence":0.3,
            "evidence":"The dated title suggests a guest mix; the recording is unverified."
        }],
        "uncertainty":"Listen to confirm the recording and musical style.",
        "research":{"artist":null,"recording":null}
    }]})
}

fn response(content: &str) -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"content":content}}]})
}

#[test]
fn complete_json_fences_parse_without_recovery() {
    let content = answer("inference").to_string();
    for wrapped in [
        content.clone(),
        format!("```json\n{content}\n```"),
        format!("```\n{content}\n```"),
        format!(" \r\n```json\r\n{content}\r\n```\r\n "),
    ] {
        let parsed = research().parse(&response(&wrapped)).unwrap();
        assert_eq!(parsed[0].tags[0].tag, "dj-mix");
        assert!(parsed[0].tags[0].source_urls.is_empty());
    }
}

#[test]
fn wrapping_never_hides_prose_extra_objects_or_truncation() {
    let content = answer("inference").to_string();
    for invalid in [
        format!("Here are the tags:\n```json\n{content}\n```"),
        format!("```json\n{content}\n```\nDone."),
        format!("```json\n{content}\n```\n{{}}"),
        format!("```json\n{content}\n{{}}\n```"),
        format!("{content}\n{{}}"),
        format!("```json\n{content}"),
        format!("```json\n{content}\n``"),
        format!("```json\n{content}\n````"),
        format!("```javascript\n{content}\n```"),
        format!("```json\n```json\n{content}\n```\n```"),
    ] {
        assert!(research().parse(&response(&invalid)).is_err(), "{invalid}");
    }
}

#[test]
fn historic_glm_bare_json_with_stray_closing_backticks_still_parses() {
    let content = answer("inference").to_string();
    for closing in ["``", "```", "````"] {
        assert!(research()
            .parse(&response(&format!("{content}\n{closing}")))
            .is_ok());
    }
}

#[test]
fn non_database_tags_may_omit_sources() {
    for basis in ["metadata", "inference"] {
        let parsed = research()
            .parse(&response(&answer(basis).to_string()))
            .unwrap();
        assert!(parsed[0].tags[0].source_urls.is_empty());
    }
}

#[test]
fn database_tags_still_require_a_supporting_source() {
    let mut content = answer("database");
    for sources in [None, Some(json!([])), Some(json!(["s1"]))] {
        if let Some(sources) = sources {
            content["items"][0]["tags"][0]["sources"] = sources;
        }
        assert!(research().parse(&response(&content.to_string())).is_err());
    }
}

#[test]
fn fences_and_default_sources_do_not_relax_other_validation() {
    for invalid in [
        {
            let mut content = answer("inference");
            content["items"][0]["tags"][0]["sources"] = Value::Null;
            content
        },
        {
            let mut content = answer("inference");
            content["items"][0]["tags"][0]["notes"] = json!("extra field");
            content
        },
        {
            let mut content = answer("inference");
            content["items"][0]["id"] = json!("t02");
            content
        },
    ] {
        assert!(research()
            .parse(&response(&format!("```json\n{invalid}\n```")))
            .is_err());
    }
}
