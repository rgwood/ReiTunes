use crate::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize)]
struct Source {
    handle: String,
    kind: String,
    mbid: String,
    data: Value,
    attached: BTreeSet<String>,
}
pub struct Research {
    items: Vec<Input>,
    sources: Vec<Source>,
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}
fn clean(value: &str) -> String {
    let mut value = value.to_lowercase();
    for decoration in [
        "[official audio]",
        "(official audio)",
        "[official video]",
        "(official video)",
        " - topic",
        ".mp3",
        ".flac",
        ".wav",
    ] {
        value = value.replace(decoration, "");
    }
    value
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<_> = a.chars().collect();
    let b: Vec<_> = b.chars().collect();
    let mut row: Vec<_> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut next = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            next.push(
                (row[j + 1] + 1)
                    .min(next[j] + 1)
                    .min(row[j] + usize::from(ca != cb)),
            );
        }
        row = next;
    }
    row[b.len()]
}
fn anchored_artist(item: &Input, candidate: &Value) -> bool {
    let mut names = vec![string(candidate, "name")];
    for alias in array(candidate, "aliases") {
        names.push(alias.as_str().unwrap_or_else(|| string(alias, "name")));
    }
    names
        .into_iter()
        .filter(|name| !name.is_empty())
        .any(|name| {
            let raw_name = name.to_lowercase();
            let name = clean(name);
            let artist = clean(&item.artist);
            let title = clean(&item.name);
            let raw_title = item.name.to_lowercase();
            // A title that happens to equal an artist name is not an artist
            // credit. Require an explicit artist/title or set-title structure.
            let embedded = [" - ", " — ", " – ", ": "]
                .iter()
                .any(|separator| raw_title.starts_with(&format!("{raw_name}{separator}")))
                || [" live ", " from ", " at ", " dj set", " essential mix"]
                    .iter()
                    .any(|suffix| title.starts_with(&format!("{name}{suffix}")));
            name == artist
                || (name.chars().count() >= 5
                    && artist.chars().count() >= 5
                    && edit_distance(&name, &artist) <= 2)
                || (name.len() >= 3 && embedded)
        })
}
fn credits(data: &Value) -> Vec<Value> {
    if data.get("artist-credit").is_some() {
        array(data, "artist-credit")
            .iter()
            .filter_map(|c| c.get("artist").cloned())
            .collect()
    } else {
        array(data, "artist_credits")
            .iter()
            .map(|c| {
                if c.is_string() {
                    json!({"name":c})
                } else {
                    c.clone()
                }
            })
            .collect()
    }
}

impl Research {
    pub fn new(items: &[Input]) -> Result<Self> {
        let mut this = Self {
            items: items.to_vec(),
            sources: Vec::new(),
        };
        for item in items {
            for (field, kind) in [
                ("artist", "artist"),
                ("recording", "recording"),
                ("release_candidate", "release"),
            ] {
                let mut data = item.musicbrainz[field].clone();
                if data.is_object() {
                    data["id"] = data["mbid"].clone();
                    this.register(kind, data, std::slice::from_ref(&item.id))?;
                }
            }
        }
        Ok(this)
    }
    fn register(&mut self, kind: &str, data: Value, ids: &[String]) -> Result<String> {
        let mbid = string(&data, "id");
        uuid::Uuid::parse_str(mbid).context("Invalid MusicBrainz candidate ID")?;
        if let Some(existing) = self
            .sources
            .iter_mut()
            .find(|s| s.kind == kind && s.mbid == mbid)
        {
            existing.attached.extend(ids.iter().cloned());
            // Detail lookups enrich search candidates instead of changing handles.
            if let (Some(old), Some(new)) = (existing.data.as_object_mut(), data.as_object()) {
                for (key, value) in new {
                    old.insert(key.clone(), value.clone());
                }
            }
            return Ok(existing.handle.clone());
        }
        let handle = format!("s{}", self.sources.len() + 1);
        self.sources.push(Source {
            handle: handle.clone(),
            kind: kind.into(),
            mbid: mbid.into(),
            data,
            attached: ids.iter().cloned().collect(),
        });
        Ok(handle)
    }
    fn source(&self, handle: &str) -> Result<&Source> {
        self.sources
            .iter()
            .find(|s| s.handle == handle)
            .context("Unknown evidence handle")
    }
    fn eligible(&self, source: &Source, item: &Input) -> bool {
        match source.kind.as_str() {
            "artist" => {
                if !anchored_artist(item, &source.data) {
                    return false;
                }
                // A fuzzy/exact name may name multiple people. Require a unique
                // anchored artist among candidates actually retrieved for this item.
                let unique_name = self
                    .sources
                    .iter()
                    .filter(|s| {
                        s.kind == "artist"
                            && s.attached.contains(&item.id)
                            && anchored_artist(item, &s.data)
                    })
                    .count()
                    <= 1;
                // Two artists can share a name. An independently matching title
                // (and album where needed) can disambiguate the credited artist.
                // The original artist anchor above is still mandatory.
                unique_name
                    || self.sources.iter().any(|recording| {
                        recording.kind == "recording"
                            && recording.attached.contains(&item.id)
                            && self.eligible(recording, item)
                            && credits(&recording.data)
                                .iter()
                                .any(|credit| string(credit, "id") == source.mbid)
                    })
            }
            "recording" => {
                let matches = |s: &Source| {
                    s.kind == "recording"
                        && clean(string(&s.data, "title")) == clean(&item.name)
                        && credits(&s.data).iter().any(|a| anchored_artist(item, a))
                };
                if !matches(source) {
                    return false;
                }
                let candidates: Vec<_> = self
                    .sources
                    .iter()
                    .filter(|s| s.attached.contains(&item.id) && matches(s))
                    .collect();
                if candidates.len() <= 1 {
                    return true;
                }
                let album_matches = |s: &&Source| {
                    !item.album.is_empty()
                        && array(&s.data, "releases")
                            .iter()
                            .any(|r| clean(string(r, "title")) == clean(&item.album))
                };
                candidates.iter().filter(|s| album_matches(s)).count() == 1
                    && album_matches(&source)
            }
            "release" => {
                !item.album.is_empty()
                    && clean(&item.album) == clean(string(&source.data, "title"))
                    && (credits(&source.data)
                        .iter()
                        .any(|a| anchored_artist(item, a))
                        || self.sources.iter().any(|recording| {
                            recording.kind == "recording"
                                && recording.attached.contains(&item.id)
                                && self.eligible(recording, item)
                                && array(&recording.data, "releases")
                                    .iter()
                                    .any(|release| string(release, "id") == source.mbid)
                        }))
            }
            _ => false,
        }
    }
    fn public(&self, source: &Source) -> Value {
        let links = |kind: &str, data: &Value| {
            self.sources
                .iter()
                .find(|s| s.kind == kind && s.mbid == string(data, "id"))
                .map(|s| s.handle.as_str())
        };
        let artist_credits: Vec<_> = credits(&source.data)
            .iter()
            .map(|a| json!({"name":a["name"],"handle":links("artist",a)}))
            .collect();
        let releases: Vec<_> = array(&source.data, "releases")
            .iter()
            .take(5)
            .map(|r| json!({"title":r["title"],"date":r["date"],"handle":links("release",r)}))
            .collect();
        let community_tags: Vec<_> = if source.data.get("tags").is_some() {
            array(&source.data, "tags")
                .iter()
                .take(8)
                .map(|t| t["name"].clone())
                .collect()
        } else {
            array(&source.data, "community_tags")
                .iter()
                .take(8)
                .cloned()
                .collect()
        };
        let aliases: Vec<_> = array(&source.data, "aliases")
            .iter()
            .take(8)
            .map(|a| {
                if a.is_string() {
                    a.clone()
                } else {
                    a["name"].clone()
                }
            })
            .collect();
        let relationships: Vec<_> = array(&source.data, "relations").iter().take(12).map(|r| json!({"type":r["type"],"attributes":r["attributes"],"name":r["artist"]["name"].as_str().or(r["work"]["title"].as_str())})).chain(array(&source.data, "relationships").iter().take(12).cloned()).collect();
        json!({"handle":source.handle,"kind":source.kind,"name":source.data["name"],"title":source.data["title"],"aliases":aliases,
            "disambiguation":source.data["disambiguation"],"community_tags":community_tags,"artist_credits":artist_credits,"releases":releases,"relationships":relationships,
            "date":source.data["date"],"first_release_date":source.data["first-release-date"],
            "attached_items":source.attached,"eligible_items":self.items.iter().filter(|i| self.eligible(source,i)).map(|i| &i.id).collect::<Vec<_>>(),
            "caveat":"Metadata candidate, never fingerprint-verified. Artist tags may not describe this recording or an entire mix."})
    }
    pub fn audit(&self) -> Value {
        json!(self.sources.iter().map(|s| json!({"handle":s.handle,"kind":s.kind,"mbid":s.mbid,"attached":s.attached,"eligible":self.items.iter().filter(|i|self.eligible(s,i)).map(|i|&i.id).collect::<Vec<_>>()})).collect::<Vec<_>>())
    }
    pub fn initial_request(&self) -> Result<Value> {
        let mut request = CONTRACT["request"].clone();
        let items: Vec<_> = self.items.iter().map(|i| json!({"id":i.id,"name":i.name,"artist":i.artist,"album":i.album,"research_reasons":i.musicbrainz["research_reasons"]})).collect();
        let sources: Vec<_> = self.sources.iter().map(|s| self.public(s)).collect();
        request["messages"] = json!([
            {"role":"system","content":include_str!("../agent-prompt.txt")},
            {"role":"user","content":serde_json::to_string(&json!({"items":items,"cached_evidence":sources}))?}
        ]);
        Ok(request)
    }
    pub fn tools(&self) -> Value {
        let ids: Vec<_> = self.items.iter().map(|i| &i.id).collect();
        let tool = |name: &str, description: &str, mut properties: Value, required: &[&str]| {
            properties["item_ids"] = json!({"type":"array","minItems":1,"maxItems":20,"uniqueItems":true,"items":{"type":"string","enum":ids}});
            let mut required = required.to_vec();
            required.push("item_ids");
            json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})
        };
        let s = json!({"type":"string","maxLength":180});
        json!([
            tool("search_artists","Search artist candidates; clean decoration or correct suspected typos. Share one search across related item_ids.",json!({"name":s}), &["name"]),
            tool("search_recordings","Search title with optional artist and album. Omit absent fields. Queries are hypotheses, not proof. Preserve meaningful versions.",json!({"title":s,"artist":s,"album":s}), &["title"]),
            tool("lookup_entity","Look up a returned handle for artist, recording or release details. Can attach it to additional independently anchored items.",json!({"handle":s}), &["handle"]),
            tool("share_evidence","Explicitly attach an existing handle to related tracks; original metadata must independently anchor each target.",json!({"handle":s}), &["handle"])
        ])
    }
    pub async fn execute(&mut self, call: &Value, mb: &mut impl MusicBrainz) -> Result<Value> {
        let name = string(&call["function"], "name");
        let args: Value = serde_json::from_str(string(&call["function"], "arguments"))
            .context("Tool arguments must be JSON")?;
        let object = args
            .as_object()
            .context("Tool arguments must be an object")?;
        let allowed = match name {
            "search_artists" => vec!["item_ids", "name"],
            "search_recordings" => vec!["item_ids", "title", "artist", "album"],
            "lookup_entity" | "share_evidence" => vec!["item_ids", "handle"],
            _ => bail!("Unknown tool"),
        };
        if object.keys().any(|k| !allowed.contains(&k.as_str())) {
            bail!("Unknown tool argument");
        }
        let ids: Vec<String> = serde_json::from_value(args["item_ids"].clone())
            .context("item_ids must be supplied")?;
        if ids.is_empty()
            || ids.len() > 20
            || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
            || ids.iter().any(|id| !self.items.iter().any(|i| &i.id == id))
        {
            bail!("Invalid item_ids");
        }
        for (key, value) in object.iter().filter(|(k, _)| k.as_str() != "item_ids") {
            if value
                .as_str()
                .is_none_or(|s| s.len() > 180 || s.chars().any(char::is_control))
            {
                bail!("Invalid {key}");
            }
        }
        let mut handles = Vec::new();
        if name == "lookup_entity" || name == "share_evidence" {
            let source = self.source(string(&args, "handle"))?.clone();
            for id in &ids {
                let item = self.items.iter().find(|i| &i.id == id).unwrap();
                if (name == "share_evidence" || !source.attached.contains(id))
                    && !self.eligible(&source, item)
                {
                    bail!("Cannot share evidence without an independent original-metadata anchor for {id}");
                }
            }
            let data = if name == "lookup_entity" {
                mb.get(&source.kind, Some(&source.mbid), None).await?
            } else {
                source.data
            };
            handles.push(self.register(&source.kind, data, &ids)?);
        } else {
            let (kind, mut query) = if name == "search_artists" {
                if string(&args, "name").trim().is_empty() {
                    bail!("name is required");
                }
                (
                    "artist",
                    format!("artist:{}", evidence::quoted(string(&args, "name"))),
                )
            } else {
                if string(&args, "title").trim().is_empty() {
                    bail!("title is required");
                }
                (
                    "recording",
                    format!("recording:{}", evidence::quoted(string(&args, "title"))),
                )
            };
            for (field, mb_field) in [("artist", "artist"), ("album", "release")] {
                if !string(&args, field).trim().is_empty() {
                    query.push_str(&format!(
                        " AND {mb_field}:{}",
                        evidence::quoted(string(&args, field))
                    ));
                }
            }
            let data = mb.get(kind, None, Some(&query)).await?;
            for candidate in array(&data, &format!("{kind}s")).iter().take(5) {
                handles.push(self.register(kind, candidate.clone(), &ids)?);
            }
        }
        // Server registers related entities and issues handles; the model never copies UUIDs.
        for handle in handles.clone() {
            let source = self.source(&handle)?.clone();
            for artist in credits(&source.data) {
                if artist["id"].is_string() {
                    handles.push(self.register("artist", artist, &ids)?);
                }
            }
            for release in array(&source.data, "releases").iter().take(5) {
                if release["id"].is_string() {
                    handles.push(self.register("release", release.clone(), &ids)?);
                }
            }
        }
        handles.sort();
        handles.dedup();
        Ok(
            json!({"candidates":handles.iter().map(|h|self.public(self.source(h).unwrap())).collect::<Vec<_>>(),"warning":"Search choices do not corroborate original metadata. Only eligible_items may cite a candidate. Ambiguous versions must remain unresolved."}),
        )
    }
    fn resolve(&self, handle: &str, item: &Input, kind: Option<&str>) -> Result<&Source> {
        let source = self.source(handle)?;
        if kind.is_some_and(|kind| source.kind != kind) {
            bail!("Wrong entity kind for {handle}");
        }
        if !source.attached.contains(&item.id) {
            bail!(
                "Handle {handle} not attached to {}; use share_evidence",
                item.id
            );
        }
        if !self.eligible(source, item) {
            bail!(
                "Handle {handle} lacks an unambiguous original-metadata anchor for {}; abstain",
                item.id
            );
        }
        Ok(source)
    }
    pub fn parse(&self, raw: &Value) -> Result<Vec<Prediction>> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Batch {
            items: Vec<Item>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Item {
            id: String,
            tags: Vec<WireTag>,
            uncertainty: String,
            research: Identity,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Identity {
            artist: Option<String>,
            recording: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireTag {
            tag: String,
            basis: String,
            confidence: f64,
            evidence: String,
            sources: Vec<String>,
        }
        if raw["choices"][0]["finish_reason"] != "stop" {
            bail!("Model did not finish normally");
        }
        let content = raw["choices"][0]["message"]["content"]
            .as_str()
            .context("Missing final JSON")?
            .trim();
        let mut stream = serde_json::Deserializer::from_str(content).into_iter::<Batch>();
        let batch = stream.next().context("Empty final output")??;
        let tail = content[stream.byte_offset()..].trim();
        if !tail.is_empty() && !(tail.len() >= 2 && tail.bytes().all(|b| b == b'`')) {
            bail!("Extra content after JSON");
        }
        let mut by_id = BTreeMap::new();
        for item in batch.items {
            if by_id.insert(item.id.clone(), item).is_some() {
                bail!("Duplicate item ID");
            }
        }
        if by_id.len() != self.items.len() {
            bail!("Missing or invented item IDs");
        }
        self.items.iter().map(|input| {
            let item = by_id.remove(&input.id).context("Missing or invented item ID")?;
            let mut research = json!({"status":"metadata-candidates-only","artist_mbid":null,"recording_mbid":null});
            for (kind,handle) in [("artist",item.research.artist),("recording",item.research.recording)] {
                if let Some(handle) = handle { research[format!("{kind}_mbid")] = json!(self.resolve(&handle,input,Some(kind))?.mbid); }
            }
            let mut tags = Vec::new();
            let mut sources = Vec::new();
            for tag in item.tags {
                if tag.sources.len()>3 { bail!("Too many source handles"); }
                let mut urls = Vec::new();
                let normalized = baseline::normalize_tag(&tag.tag)?;
                let mut supports_database_tag = false;
                for handle in tag.sources {
                    let source = self.resolve(&handle,input,None)?;
                    let supplied = self.public(source);
                    supports_database_tag |= array(&supplied,"community_tags").iter().filter_map(Value::as_str)
                        .any(|name| baseline::normalize_tag(name).is_ok_and(|name| name == normalized));
                    supports_database_tag |= array(&supplied,"relationships").iter().any(|relation| {
                        (normalized == "vocal" && string(relation,"type") == "vocal")
                            || array(relation,"attributes").iter().filter_map(Value::as_str)
                                .any(|name| baseline::normalize_tag(name).is_ok_and(|name| name == normalized))
                    });
                    let url = format!("https://musicbrainz.org/{}/{}",source.kind,source.mbid);
                    urls.push(url.clone()); sources.push(url);
                }
                if tag.basis == "database" && !supports_database_tag {
                    bail!("Database tag '{}' has no matching supplied community tag or performance credit; use a justified inference or abstain",tag.tag);
                }
                tags.push(Tag { tag:tag.tag,basis:tag.basis,confidence:tag.confidence,evidence:tag.evidence,source_urls:urls });
            }
            baseline::validate_prediction(Prediction {id:item.id,tags,uncertainty:item.uncertainty,research},&json!({"sources":sources}))
        }).collect()
    }
}
