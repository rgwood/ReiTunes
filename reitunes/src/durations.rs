use crate::*;

pub fn valid(seconds: f64) -> bool {
    seconds.is_finite() && seconds > 0.0 && seconds <= 366.0 * 86400.0
}

#[derive(Deserialize)]
pub struct DurationRequest {
    duration_seconds: f64,
    file_path: String,
}

// File identity prevents a delayed metadata read from updating a replaced file.
pub(crate) async fn persist(state: &AppState, id: Uuid, path: &str, seconds: f64, only_missing: bool) -> Result<bool> {
    let mut library = state.library.write().await;
    let Some(item) = library.items.get(&id).filter(|item| item.file_path == path) else { return Ok(false); };
    if item.duration_seconds.is_some_and(|old| only_missing || (old - seconds).abs() < 0.1) { return Ok(true); }
    let event = EventWithMetadata::new(id, Event::LibraryItemDurationChangedEvent { seconds })?;
    save_event_to_db(&*DB.get()?, &event)?;
    library.apply(&event);
    let item = LibraryItemResponse::from_item(&library.items[&id], &state.storage);
    let _ = state.update_tx.send(FrontendUpdate::Update { item: Box::new(item) });
    Ok(true)
}

pub async fn save(State(state): State<AppState>, Path(id): Path<Uuid>, JsonExtractor(request): JsonExtractor<DurationRequest>) -> Result<Response, AppError> {
    if !valid(request.duration_seconds) { return Ok(StatusCode::BAD_REQUEST.into_response()); }
    let saved = persist(&state, id, &request.file_path, request.duration_seconds, false).await?;
    Ok(if saved { StatusCode::NO_CONTENT } else { StatusCode::CONFLICT }.into_response())
}

pub fn import(state: AppState, id: Uuid, path: String, source: Option<String>, seconds: Option<f64>) {
    tokio::spawn(async move {
        let seconds = if let Some(seconds) = seconds.filter(|seconds| valid(*seconds)) {
            Some(seconds)
        } else if let Some(source) = source.filter(|url| discovery::item_identifier(url).is_some()) {
            match discovery::metadata_endpoint() {
                Ok(endpoint) => discovery::extract(&endpoint, &source, 1, false).await.ok()
                    .and_then(|value| value["duration"].as_f64()).filter(|seconds| valid(*seconds)),
                Err(_) => None,
            }
        } else { None };
        if let Some(seconds) = seconds {
            if let Err(error) = persist(&state, id, &path, seconds, true).await {
                warn!(%id, %error, "Could not save imported audio duration");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duration_must_be_a_finite_positive_length() {
        for seconds in [f64::NAN, f64::INFINITY, -1.0, 0.0, 1e12] { assert!(!valid(seconds)); }
        for seconds in [0.1, 242.65, 7200.0] { assert!(valid(seconds)); }
    }
}
