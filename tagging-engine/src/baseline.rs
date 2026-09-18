//! Archived fixed-collector mode, invoked by the shared engine for comparisons.
use crate::*;
use std::collections::{HashMap, HashSet};
pub fn normalize_tag(tag: &str) -> Result<String> {
    let tag = tag
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    if tag.is_empty() || tag.chars().count() > 60 || tag.chars().any(char::is_control) {
        bail!("Tags must contain 1–60 characters without control characters");
    }
    Ok(tag)
}

pub fn build_request(items: &[Input]) -> Result<Value> {
    if items.is_empty() || items.len() > MAX_BATCH_ITEMS {
        bail!("Batch must contain 1–20 items");
    }
    let ids: Vec<_> = (1..=items.len()).map(|i| format!("t{i:02}")).collect();
    let metadata: Vec<_> = items.iter().zip(&ids).map(|(item, id)| {
        json!({"id":id,"name":item.name,"artist":item.artist,"album":item.album,"musicbrainz":item.musicbrainz})
    }).collect();
    let mut request = CONTRACT["request"].clone();
    // Match the evaluated schema text byte for byte, including its ID list spacing.
    let id_list = format!(
        "[{}]",
        ids.iter()
            .map(|id| format!("\"{id}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    request["messages"][0]["content"] = json!(request["messages"][0]["content"]
        .as_str()
        .unwrap()
        .replace("__ITEM_IDS__", &id_list));
    request["messages"][1]["content"] = json!(serde_json::to_string(&metadata)?);
    if serde_json::to_vec(&request)?.len()
        > CONTRACT["max_request_bytes"].as_u64().unwrap() as usize
    {
        bail!("Tagging request exceeds 48 KB; reduce evidence");
    }
    Ok(request)
}

pub fn parse_predictions(raw: &Value, items: &[Input]) -> Result<Vec<Prediction>> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Batch {
        items: Vec<Prediction>,
    }
    if raw
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        != Some("stop")
    {
        bail!("Model did not finish normally; explicit retry required");
    }
    let content = raw
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .context("Missing model response")?;
    let mut stream = serde_json::Deserializer::from_str(content.trim()).into_iter::<Batch>();
    let batch = stream.next().context("Empty model response")??;
    // The official endpoint sometimes appends Markdown closing backticks (including
    // malformed two/four-character fences). Never accept prose or a second object.
    let tail = content.trim()[stream.byte_offset()..].trim();
    if !tail.is_empty() && !(tail.len() >= 2 && tail.bytes().all(|byte| byte == b'`')) {
        bail!("Unexpected content after prediction JSON");
    }
    let mut by_id = HashMap::new();
    for prediction in batch.items {
        if by_id.insert(prediction.id.clone(), prediction).is_some() {
            bail!("Duplicate item ID");
        }
    }
    if by_id.len() != items.len() {
        bail!("Missing or invented item IDs");
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let prediction = by_id
                .remove(&format!("t{:02}", index + 1))
                .context("Missing or invented item ID")?;
            validate_prediction(prediction, &item.musicbrainz)
        })
        .collect()
}

pub fn validate_prediction(mut prediction: Prediction, evidence: &Value) -> Result<Prediction> {
    if prediction.tags.len() > 6 || prediction.uncertainty.len() > 1500 {
        bail!("Prediction exceeds size limits");
    }
    let sources: HashSet<&str> = evidence
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().or_else(|| v.get("url").and_then(Value::as_str)))
        .collect();
    let mut seen = HashSet::new();
    for tag in &mut prediction.tags {
        tag.tag = normalize_tag(&tag.tag)?;
        if !seen.insert(tag.tag.clone())
            || !tag.confidence.is_finite()
            || !(0.0..=1.0).contains(&tag.confidence)
            || tag.evidence.is_empty()
            || tag.evidence.len() > 1000
            || tag.source_urls.len() > 3
        {
            bail!("Invalid or duplicate tag");
        }
        match tag.basis.as_str() {
            // A cited source does not turn an inference into database evidence.
            // The evaluated schema permits citations on any basis; still require
            // every citation to belong to this item's supplied evidence.
            "metadata" | "inference"
                if tag
                    .source_urls
                    .iter()
                    .all(|url| sources.contains(url.as_str())) => {}
            "database"
                if !tag.source_urls.is_empty()
                    && tag
                        .source_urls
                        .iter()
                        .all(|url| sources.contains(url.as_str())) => {}
            _ => bail!("Tag has unsupported evidence basis or source URL"),
        }
    }
    Ok(prediction)
}
