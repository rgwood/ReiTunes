use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoapEnvelope<T> {
    #[serde(rename = "soapenv:Body")]
    pub body: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoapFault {
    pub faultcode: String,
    pub faultstring: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMetadataRequest {
    pub id: String,
    pub index: Option<u32>,
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMetadataResponse {
    pub index: u32,
    pub count: u32,
    pub total: u32,
    #[serde(rename = "mediaCollection")]
    pub media_collection: Option<Vec<MediaCollection>>,
    #[serde(rename = "mediaMetadata")]
    pub media_metadata: Option<Vec<MediaMetadata>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaCollection {
    pub id: String,
    pub title: String,
    #[serde(rename = "itemType")]
    pub item_type: String,
    #[serde(rename = "canPlay")]
    pub can_play: bool,
    #[serde(rename = "canEnumerate")]
    pub can_enumerate: bool,
    #[serde(rename = "canCache")]
    pub can_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub id: String,
    pub title: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "itemType")]
    pub item_type: String,
    #[serde(rename = "trackMetadata")]
    pub track_metadata: Option<TrackMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackMetadata {
    pub artist: String,
    pub album: String,
    pub duration: Option<u32>,
    #[serde(rename = "trackNumber")]
    pub track_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    pub id: String,
    pub term: String,
    pub index: Option<u32>,
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMediaURIRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetMediaURIResponse {
    #[serde(rename = "getMediaURIResult")]
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSessionIdRequest {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSessionIdResponse {
    #[serde(rename = "getSessionIdResult")]
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetLastUpdateRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetLastUpdateResponse {
    #[serde(rename = "getLastUpdateResult")]
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetExtendedMetadataRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetExtendedMetadataResponse {
    #[serde(rename = "mediaMetadata")]
    pub media_metadata: Option<MediaMetadata>,
    #[serde(rename = "mediaCollection")]
    pub media_collection: Option<MediaCollection>,
}
