use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_xml_rs::to_string;
use tracing::{debug, error, info};

use crate::smapi::auth::{handle_get_last_update, handle_get_session_id};
use crate::smapi::endpoints::*;
use crate::smapi::types::*;

pub async fn smapi_soap_handler(
    State(state): State<crate::AppState>,
    headers: HeaderMap,
    body: String,
) -> Result<Response, SoapError> {
    info!("=== SMAPI SOAP REQUEST ===");
    info!("Headers: {:?}", headers);
    info!("Body length: {} bytes", body.len());
    debug!("Full SOAP request body: {}", body);

    let soap_action = headers
        .get("SOAPAction")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    info!("SOAP Action: '{}'", soap_action);
    
    // Log other important headers
    if let Some(content_type) = headers.get("Content-Type") {
        info!("Content-Type: {:?}", content_type);
    }
    if let Some(user_agent) = headers.get("User-Agent") {
        info!("User-Agent: {:?}", user_agent);
    }

    let response = match soap_action {
        "\"http://www.sonos.com/Services/1.1#getMetadata\"" => {
            handle_get_metadata(state, body).await?
        }
        "\"http://www.sonos.com/Services/1.1#search\"" => handle_search(state, body).await?,
        "\"http://www.sonos.com/Services/1.1#getMediaURI\"" => {
            handle_get_media_uri(state, body).await?
        }
        "\"http://www.sonos.com/Services/1.1#getSessionId\"" => {
            handle_get_session_id(state, body).await?
        }
        "\"http://www.sonos.com/Services/1.1#getLastUpdate\"" => {
            handle_get_last_update(state, body).await?
        }
        "\"http://www.sonos.com/Services/1.1#getExtendedMetadata\"" => {
            handle_get_extended_metadata(state, body).await?
        }
        _ => {
            error!("Unsupported SOAP operation: '{}'", soap_action);
            return Err(SoapError::UnsupportedOperation(soap_action.to_string()));
        }
    };

    info!("=== SMAPI SOAP RESPONSE ===");
    info!("Response length: {} bytes", response.len());
    debug!("Full SOAP response: {}", response);
    
    // Also log first 500 chars at INFO level for easier debugging
    if response.len() > 500 {
        info!("Response preview: {}...", &response[..500]);
    } else {
        info!("Full response: {}", response);
    }

    let final_response = Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/xml; charset=utf-8")
        .body(Body::from(response))?;
    
    info!("Response sent successfully");
    Ok(final_response)
}

#[derive(Debug, thiserror::Error)]
pub enum SoapError {
    #[error("XML parsing error: {0}")]
    XmlParsing(#[from] serde_xml_rs::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] axum::http::Error),
    #[error("Unsupported operation: {0}")]
    UnsupportedOperation(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for SoapError {
    fn into_response(self) -> Response {
        error!("=== SMAPI SOAP ERROR ===");
        error!("Error type: {:?}", self);
        
        let fault = match self {
            SoapError::UnsupportedOperation(op) => SoapFault {
                faultcode: "Client.UnsupportedOperation".to_string(),
                faultstring: format!("Unsupported operation: {}", op),
                detail: None,
            },
            _ => SoapFault {
                faultcode: "Server.InternalError".to_string(),
                faultstring: self.to_string(),
                detail: None,
            },
        };

        let fault_response = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <soap:Fault>
            <faultcode>{}</faultcode>
            <faultstring>{}</faultstring>
        </soap:Fault>
    </soap:Body>
</soap:Envelope>"#,
            fault.faultcode, fault.faultstring
        );

        error!("Fault response: {}", fault_response);

        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header("Content-Type", "text/xml; charset=utf-8")
            .body(Body::from(fault_response))
            .unwrap()
    }
}

pub fn create_soap_response<T: serde::Serialize>(
    _action: &str,
    data: T,
) -> Result<String, SoapError> {
    let response_json = serde_json::to_string(&data)
        .map_err(|e| SoapError::Internal(format!("JSON serialization error: {}", e)))?;

    info!("Response JSON: {}", response_json);

    // Convert to simple XML manually for now
    let response_xml = json_to_simple_xml(&response_json, _action)?;

    let full_response = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        {}
    </soap:Body>
</soap:Envelope>"#,
        response_xml
    );

    Ok(full_response)
}

fn json_to_simple_xml(json_str: &str, root_element: &str) -> Result<String, SoapError> {
    let json_value: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| SoapError::Internal(format!("JSON parsing error: {}", e)))?;

    match root_element {
        "getSessionIdResponse" => {
            if let Some(result) = json_value.get("getSessionIdResult") {
                if let Some(result_str) = result.as_str() {
                    return Ok(format!("<getSessionIdResponse><getSessionIdResult>{}</getSessionIdResult></getSessionIdResponse>", result_str));
                }
            }
        }
        "getLastUpdateResponse" => {
            if let Some(result) = json_value.get("getLastUpdateResult") {
                if let Some(result_str) = result.as_str() {
                    return Ok(format!("<getLastUpdateResponse><getLastUpdateResult>{}</getLastUpdateResult></getLastUpdateResponse>", result_str));
                }
            }
        }
        "getMediaURIResponse" => {
            if let Some(result) = json_value.get("getMediaURIResult") {
                if let Some(result_str) = result.as_str() {
                    return Ok(format!("<getMediaURIResponse><getMediaURIResult>{}</getMediaURIResult></getMediaURIResponse>", result_str));
                }
            }
        }
        "getMetadataResponse" => {
            let mut xml = String::from("<getMetadataResponse><getMetadataResult>");

            if let Some(index) = json_value.get("index") {
                xml.push_str(&format!("<index>{}</index>", index));
            }
            if let Some(count) = json_value.get("count") {
                xml.push_str(&format!("<count>{}</count>", count));
            }
            if let Some(total) = json_value.get("total") {
                xml.push_str(&format!("<total>{}</total>", total));
            }

            if let Some(collections) = json_value.get("mediaCollection") {
                if let Some(collections_array) = collections.as_array() {
                    for collection in collections_array {
                        xml.push_str("<mediaCollection>");
                        if let Some(id) = collection.get("id") {
                            xml.push_str(&format!("<id>{}</id>", id.as_str().unwrap_or("")));
                        }
                        if let Some(title) = collection.get("title") {
                            xml.push_str(&format!(
                                "<title>{}</title>",
                                title.as_str().unwrap_or("")
                            ));
                        }
                        if let Some(item_type) = collection.get("itemType") {
                            xml.push_str(&format!(
                                "<itemType>{}</itemType>",
                                item_type.as_str().unwrap_or("")
                            ));
                        }
                        if let Some(can_play) = collection.get("canPlay") {
                            xml.push_str(&format!(
                                "<canPlay>{}</canPlay>",
                                can_play.as_bool().unwrap_or(false)
                            ));
                        }
                        if let Some(can_enumerate) = collection.get("canEnumerate") {
                            xml.push_str(&format!(
                                "<canEnumerate>{}</canEnumerate>",
                                can_enumerate.as_bool().unwrap_or(false)
                            ));
                        }
                        if let Some(can_cache) = collection.get("canCache") {
                            xml.push_str(&format!(
                                "<canCache>{}</canCache>",
                                can_cache.as_bool().unwrap_or(false)
                            ));
                        }
                        xml.push_str("</mediaCollection>");
                    }
                }
            }

            // Add mediaMetadata if present 
            if let Some(metadata) = json_value.get("mediaMetadata") {
                if let Some(metadata_array) = metadata.as_array() {
                    for track in metadata_array {
                        xml.push_str("<mediaMetadata>");
                        if let Some(id) = track.get("id") {
                            xml.push_str(&format!("<id>{}</id>", id.as_str().unwrap_or("")));
                        }
                        if let Some(title) = track.get("title") {
                            xml.push_str(&format!("<title>{}</title>", title.as_str().unwrap_or("")));
                        }
                        if let Some(mime_type) = track.get("mimeType") {
                            xml.push_str(&format!("<mimeType>{}</mimeType>", mime_type.as_str().unwrap_or("")));
                        }
                        if let Some(item_type) = track.get("itemType") {
                            xml.push_str(&format!("<itemType>{}</itemType>", item_type.as_str().unwrap_or("")));
                        }
                        if let Some(track_metadata) = track.get("trackMetadata") {
                            xml.push_str("<trackMetadata>");
                            if let Some(artist) = track_metadata.get("artist") {
                                xml.push_str(&format!("<artist>{}</artist>", artist.as_str().unwrap_or("")));
                            }
                            if let Some(album) = track_metadata.get("album") {
                                xml.push_str(&format!("<album>{}</album>", album.as_str().unwrap_or("")));
                            }
                            if let Some(duration) = track_metadata.get("duration") {
                                if !duration.is_null() {
                                    xml.push_str(&format!("<duration>{}</duration>", duration));
                                }
                            }
                            if let Some(track_number) = track_metadata.get("trackNumber") {
                                if !track_number.is_null() {
                                    xml.push_str(&format!("<trackNumber>{}</trackNumber>", track_number));
                                }
                            }
                            xml.push_str("</trackMetadata>");
                        }
                        xml.push_str("</mediaMetadata>");
                    }
                }
            }

            xml.push_str("</getMetadataResult></getMetadataResponse>");
            return Ok(xml);
        }
        "getExtendedMetadataResponse" => {
            let mut xml = String::from("<getExtendedMetadataResponse><getExtendedMetadataResult>");

            // Handle mediaMetadata if present
            if let Some(metadata) = json_value.get("mediaMetadata") {
                xml.push_str("<mediaMetadata>");
                if let Some(id) = metadata.get("id") {
                    xml.push_str(&format!("<id>{}</id>", id.as_str().unwrap_or("")));
                }
                if let Some(title) = metadata.get("title") {
                    xml.push_str(&format!("<title>{}</title>", title.as_str().unwrap_or("")));
                }
                if let Some(mime_type) = metadata.get("mimeType") {
                    xml.push_str(&format!("<mimeType>{}</mimeType>", mime_type.as_str().unwrap_or("")));
                }
                if let Some(item_type) = metadata.get("itemType") {
                    xml.push_str(&format!("<itemType>{}</itemType>", item_type.as_str().unwrap_or("")));
                }
                if let Some(track_metadata) = metadata.get("trackMetadata") {
                    xml.push_str("<trackMetadata>");
                    if let Some(artist) = track_metadata.get("artist") {
                        xml.push_str(&format!("<artist>{}</artist>", artist.as_str().unwrap_or("")));
                    }
                    if let Some(album) = track_metadata.get("album") {
                        xml.push_str(&format!("<album>{}</album>", album.as_str().unwrap_or("")));
                    }
                    if let Some(duration) = track_metadata.get("duration") {
                        if !duration.is_null() {
                            xml.push_str(&format!("<duration>{}</duration>", duration));
                        }
                    }
                    if let Some(track_number) = track_metadata.get("trackNumber") {
                        if !track_number.is_null() {
                            xml.push_str(&format!("<trackNumber>{}</trackNumber>", track_number));
                        }
                    }
                    xml.push_str("</trackMetadata>");
                }
                xml.push_str("</mediaMetadata>");
            }

            // Handle mediaCollection if present
            if let Some(collection) = json_value.get("mediaCollection") {
                xml.push_str("<mediaCollection>");
                if let Some(id) = collection.get("id") {
                    xml.push_str(&format!("<id>{}</id>", id.as_str().unwrap_or("")));
                }
                if let Some(title) = collection.get("title") {
                    xml.push_str(&format!("<title>{}</title>", title.as_str().unwrap_or("")));
                }
                if let Some(item_type) = collection.get("itemType") {
                    xml.push_str(&format!("<itemType>{}</itemType>", item_type.as_str().unwrap_or("")));
                }
                if let Some(can_play) = collection.get("canPlay") {
                    xml.push_str(&format!("<canPlay>{}</canPlay>", can_play.as_bool().unwrap_or(false)));
                }
                if let Some(can_enumerate) = collection.get("canEnumerate") {
                    xml.push_str(&format!("<canEnumerate>{}</canEnumerate>", can_enumerate.as_bool().unwrap_or(false)));
                }
                if let Some(can_cache) = collection.get("canCache") {
                    xml.push_str(&format!("<canCache>{}</canCache>", can_cache.as_bool().unwrap_or(false)));
                }
                xml.push_str("</mediaCollection>");
            }

            xml.push_str("</getExtendedMetadataResult></getExtendedMetadataResponse>");
            return Ok(xml);
        }
        _ => {}
    }

    Err(SoapError::Internal(format!(
        "Unknown response type: {}",
        root_element
    )))
}
