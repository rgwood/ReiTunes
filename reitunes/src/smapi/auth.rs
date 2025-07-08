use crate::smapi::soap::{create_soap_response, SoapError};
use crate::smapi::types::*;
use tracing::info;

pub async fn handle_get_session_id(
    _state: crate::AppState,
    _body: String,
) -> Result<String, SoapError> {
    info!("Handling getSessionId request");

    let response = GetSessionIdResponse {
        result: "anonymous".to_string(),
    };

    create_soap_response("getSessionIdResponse", response)
}

pub async fn handle_get_last_update(
    _state: crate::AppState,
    _body: String,
) -> Result<String, SoapError> {
    info!("Handling getLastUpdate request");

    let response = GetLastUpdateResponse {
        result: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string(),
    };

    create_soap_response("getLastUpdateResponse", response)
}
