use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::collections::VecDeque;
use tagging_engine::*;
const ARTIST: &str = "356606f6-2a91-4366-bc68-713524ac6861";
fn input(id: &str, name: &str, artist: &str) -> Input {
    Input {
        id: id.into(),
        name: name.into(),
        artist: artist.into(),
        album: "".into(),
        musicbrainz: json!({}),
    }
}
fn call(name: &str, args: Value) -> Value {
    json!({"id":"call1","type":"function","function":{"name":name,"arguments":args.to_string()}})
}
fn final_answer(items: Value) -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":json!({"items":items}).to_string()}}],"usage":{"cost":0.001}})
}
fn prediction(id: &str, artist: Value, recording: Value, sources: Value) -> Value {
    json!({"id":id,"tags":[{"tag":"folk","basis":"database","confidence":0.8,"evidence":"Artist community tags; recording unverified","sources":sources}],"uncertainty":"Unverified recording","research":{"artist":artist,"recording":recording}})
}
struct Mb {
    calls: usize,
    answers: VecDeque<Value>,
}
impl MusicBrainz for Mb {
    async fn get(&mut self, _kind: &str, _id: Option<&str>, _query: Option<&str>) -> Result<Value> {
        self.calls += 1;
        self.answers
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("Unexpected MusicBrainz request"))
    }
}
struct Replay {
    answers: VecDeque<Value>,
    requests: Vec<Value>,
}
impl Model for Replay {
    async fn complete(&mut self, request: Value) -> Result<Value> {
        self.requests.push(request);
        self.answers
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("Unexpected model call"))
    }
}
fn artist() -> Value {
    json!({"id":ARTIST,"name":"Moonface","tags":[{"name":"folk","count":2}]})
}

#[test]
fn historic_config_keeps_the_production_request_profile() {
    let original = json!({
        "mode":"agent", "max_model_calls":6, "max_tool_calls":16,
        "max_recoveries":2, "max_request_bytes":160000
    });
    let restored: Config = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(restored.model_profile, None);
    assert_eq!(serde_json::to_value(restored).unwrap(), original);
    assert_eq!(serde_json::to_value(Config::default()).unwrap(), original);
}

#[tokio::test]
async fn model_profiles_record_and_send_the_same_effective_request() {
    let inputs = vec![input("t01", "Zqxv Nebula Teapot 7319", "")];
    for profile in [
        None,
        Some(ModelProfile::Glm),
        Some(ModelProfile::Luna),
        Some(ModelProfile::LunaLow),
    ] {
        let research = Research::new(&inputs).unwrap();
        let mut expected = research.initial_request().unwrap();
        expected.as_object_mut().unwrap().remove("response_format");
        expected["tools"] = research.tools();
        expected["tool_choice"] = json!("auto");
        if matches!(profile, Some(ModelProfile::Luna | ModelProfile::LunaLow)) {
            expected["model"] = json!("openai/gpt-6-luna");
            expected["reasoning"] = json!({"effort":if profile == Some(ModelProfile::LunaLow) { "low" } else { "none" }});
            expected["provider"] = json!({"require_parameters":true});
        }
        let mut model = Replay {
            answers: VecDeque::from([final_answer(json!([{
                "id":"t01", "tags":[], "uncertainty":"Unidentified recording",
                "research":{"artist":null,"recording":null}
            }]))]),
            requests: vec![],
        };
        let mut mb = Mb {
            calls: 0,
            answers: VecDeque::new(),
        };
        let mut trace = vec![];
        let report = run(
            &inputs,
            Config {
                model_profile: profile,
                ..Default::default()
            },
            &mut model,
            &mut mb,
            |event| {
                trace.push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(report.error.is_none(), "{:?}", report.error);
        assert_eq!(report.config.model_profile, profile);
        assert_eq!(model.requests, vec![expected.clone()]);
        assert_eq!(trace[1]["event"], "request");
        assert_eq!(trace[1]["request"], expected);
        assert_eq!(mb.calls, 0);
    }
}

#[tokio::test]
async fn production_engine_replays_tool_search_lookup_sharing_and_handle_resolution() {
    let inputs = vec![
        input("t01", "Black Is Back in Style", "Moonfaec"),
        input("t02", "Other song", "Moonface - Topic"),
    ];
    let mut model = Replay {
        answers: VecDeque::from([
            json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[call("search_artists",json!({"item_ids":["t01"],"name":"Moonface"}))]}}],"usage":{"cost":0.001}}),
            json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[call("lookup_entity",json!({"item_ids":["t01"],"handle":"s1"})),{"id":"call2","type":"function","function":{"name":"share_evidence","arguments":json!({"item_ids":["t02"],"handle":"s1"}).to_string()}}]}}],"usage":{"cost":0.001}}),
            final_answer(json!([
                prediction("t02", json!("s1"), Value::Null, json!(["s1"])),
                prediction("t01", json!("s1"), Value::Null, json!(["s1"]))
            ])),
        ]),
        requests: vec![],
    };
    let mut mb = Mb {
        calls: 0,
        answers: VecDeque::from([json!({"artists":[artist()]}), artist()]),
    };
    let mut trace = vec![];
    let report = run(&inputs, Config::default(), &mut model, &mut mb, |event| {
        trace.push(event);
        Ok(())
    })
    .await
    .unwrap();
    assert!(report.error.is_none(), "{:?}", report.error);
    assert_eq!(report.model_calls, 3);
    assert_eq!(report.tool_calls, 3);
    assert_eq!(mb.calls, 2);
    assert_eq!(report.reported_cost_usd, 0.003);
    let result = report.predictions.unwrap();
    assert_eq!(result[0].id, "t01");
    assert_eq!(
        result[1].tags[0].source_urls,
        vec![format!("https://musicbrainz.org/artist/{ARTIST}")]
    );
    assert_eq!(result[0].research["artist_mbid"], ARTIST);
    assert_eq!(trace[1]["event"], "request");
    assert_eq!(model.requests[0]["provider"]["only"], json!(["z-ai"]));
    assert_eq!(model.requests[0]["reasoning"]["effort"], "high");
    assert!(!model.requests[1].to_string().contains(ARTIST));
    assert!(!model.requests[1]
        .to_string()
        .contains("https://musicbrainz.org/artist/"));
}

#[tokio::test]
async fn optional_arguments_work_but_search_assumption_cannot_confirm_itself() {
    let inputs = vec![input("t01", "Barbarian", "")];
    let mut research = Research::new(&inputs).unwrap();
    let mut mb = Mb {
        calls: 0,
        answers: VecDeque::from([
            json!({"recordings":[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","title":"Barbarian","artist-credit":[{"artist":artist()}]}]}),
        ]),
    };
    let result = research
        .execute(
            &call(
                "search_recordings",
                json!({"item_ids":["t01"],"title":"Barbarian","artist":"Moonface"}),
            ),
            &mut mb,
        )
        .await
        .unwrap();
    assert_eq!(mb.calls, 1); // album was omitted, not rejected.
    assert!(result["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["eligible_items"] == json!([])));
    assert!(research
        .parse(&final_answer(json!([prediction(
            "t01",
            json!("s2"),
            json!("s1"),
            json!(["s1"])
        )])))
        .is_err());
    assert!(research
        .execute(
            &call("share_evidence", json!({"item_ids":["t01"],"handle":"s2"})),
            &mut mb
        )
        .await
        .is_err());
    let defs = research.tools();
    assert_eq!(
        defs[1]["function"]["parameters"]["required"],
        json!(["title", "item_ids"])
    );
}

#[tokio::test]
async fn versions_ambiguous_recordings_and_cross_item_citations_are_rejected() {
    for title in ["Song (Live)", "Song (Remix)", "Song"] {
        let mut research = Research::new(&[
            input("t01", title, "Moonface"),
            input("t02", "Other song", "Moonface"),
        ])
        .unwrap();
        let recordings = vec![
            json!({"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","title":"Song","artist-credit":[{"artist":artist()}]}),
            json!({"id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","title":"Song","artist-credit":[{"artist":artist()}]}),
        ];
        let mut mb = Mb {
            calls: 0,
            answers: VecDeque::from([json!({"recordings":recordings})]),
        };
        research
            .execute(
                &call(
                    "search_recordings",
                    json!({"item_ids":["t01"],"title":"Song"}),
                ),
                &mut mb,
            )
            .await
            .unwrap();
        let mut first = prediction("t01", Value::Null, json!("s1"), json!(["s1"]));
        let mut second = prediction("t02", Value::Null, Value::Null, json!([]));
        second["tags"] = json!([]);
        assert!(research
            .parse(&final_answer(json!([first, second])))
            .is_err());
        first = prediction("t01", Value::Null, Value::Null, json!([]));
        first["tags"] = json!([]);
        second = prediction("t02", json!("s3"), Value::Null, json!(["s3"]));
        assert!(research
            .parse(&final_answer(json!([first, second])))
            .is_err());
    }
}

#[tokio::test]
async fn invalid_output_recovery_is_bounded_and_never_calls_tools_after_finalization() {
    let mut invalid = final_answer(json!([]));
    invalid["choices"][0]["message"]["content"] = json!("Prose {broken}");
    let valid = final_answer(
        json!([{"id":"t01","tags":[],"uncertainty":"Unknown","research":{"artist":null,"recording":null}}]),
    );
    for recovers in [false, true] {
        let mut model = Replay {
            answers: VecDeque::from([
                invalid.clone(),
                if recovers {
                    valid.clone()
                } else {
                    invalid.clone()
                },
                invalid.clone(),
            ]),
            requests: vec![],
        };
        let mut mb = Mb {
            calls: 0,
            answers: VecDeque::new(),
        };
        let report = run(
            &[input("t01", "Unknown", "")],
            Config::default(),
            &mut model,
            &mut mb,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(report.predictions.is_some(), recovers);
        assert_eq!(report.model_calls, if recovers { 2 } else { 3 });
        assert!(model.requests[1].get("tools").is_none());
        assert!(model.requests[1].get("tool_choice").is_none());
        assert_eq!(mb.calls, 0);
    }
}

#[tokio::test]
async fn transport_failure_is_not_retried_and_has_unknown_cost() {
    struct Broken;
    impl Model for Broken {
        async fn complete(&mut self, _: Value) -> Result<Value> {
            bail!("timeout")
        }
    }
    let mut mb = Mb {
        calls: 0,
        answers: VecDeque::new(),
    };
    let report = run(
        &[input("t01", "Unknown", "")],
        Config::default(),
        &mut Broken,
        &mut mb,
        |_| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(report.model_calls, 1);
    assert_eq!(report.missing_cost_records, 1);
    assert!(report.error.is_some());
}

#[tokio::test]
async fn original_title_disambiguates_names_but_a_search_query_does_not() {
    let mut item = input("t01", "Black Is Back in Style", "Moonfaec");
    item.album = "Julia With Blue Jeans On".into();
    let mut research = Research::new(&[item]).unwrap();
    let mut mb = Mb {
        calls: 0,
        answers: VecDeque::from([
            json!({"artists":[artist(),{"id":"cccccccc-cccc-cccc-cccc-cccccccccccc","name":"Moonface"}]}),
            json!({"recordings":[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","title":"Black Is Back in Style","artist-credit":[{"artist":artist()}],"releases":[{"id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","title":"Julia With Blue Jeans On"}]}]}),
        ]),
    };
    research
        .execute(
            &call(
                "search_artists",
                json!({"item_ids":["t01"],"name":"Moonface"}),
            ),
            &mut mb,
        )
        .await
        .unwrap();
    let answer = final_answer(json!([prediction(
        "t01",
        json!("s1"),
        Value::Null,
        json!(["s1"])
    )]));
    assert!(research.parse(&answer).is_err());
    research
        .execute(
            &call(
                "search_recordings",
                json!({"item_ids":["t01"],"title":"Black Is Back in Style","artist":"Moonface"}),
            ),
            &mut mb,
        )
        .await
        .unwrap();
    assert!(research.parse(&answer).is_ok());
    let mut unsupported = prediction("t01", json!("s1"), Value::Null, json!(["s1"]));
    unsupported["tags"][0]["tag"] = json!("instrumental");
    assert!(research.parse(&final_answer(json!([unsupported]))).is_err());
}

#[tokio::test]
async fn a_generic_title_that_is_also_an_artist_name_is_not_an_artist_credit() {
    let mut research = Research::new(&[input("t01", "Barbarian", "")]).unwrap();
    let mut mb = Mb {
        calls: 0,
        answers: VecDeque::from([
            json!({"artists":[{"id":ARTIST,"name":"Barbarian","tags":[{"name":"metal"}]}]}),
        ]),
    };
    let result = research
        .execute(
            &call(
                "search_artists",
                json!({"item_ids":["t01"],"name":"Barbarian"}),
            ),
            &mut mb,
        )
        .await
        .unwrap();
    assert_eq!(result["candidates"][0]["eligible_items"], json!([]));
    assert!(research
        .parse(&final_answer(json!([prediction(
            "t01",
            json!("s1"),
            Value::Null,
            json!(["s1"])
        )])))
        .is_err());
}
