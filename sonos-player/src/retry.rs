use anyhow::Result;
use sonos::{AVTransport, SonosDevice, TrackMetaData};
use tracing::error;

const MAX_RETRIES: u8 = 2;

async fn retry_operation<F, Fut, T>(operation: F) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = sonos::Result<T>>,
{
    let mut retries = 0;
    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) if retries < MAX_RETRIES => {
                retries += 1;
                error!("Operation failed, retrying ({}/{}): {:?}", retries, MAX_RETRIES, e);
            }
            Err(e) => {
                error!("Operation failed after {} retries: {:?}", MAX_RETRIES, e);
                return Err(e.into());
            }
        }
    }
}

pub async fn play_with_retry(device: &SonosDevice) -> Result<()> {
    retry_operation(|| device.play()).await
}

pub async fn pause_with_retry(device: &SonosDevice) -> Result<()> {
    retry_operation(|| device.pause()).await
}

pub async fn stop_with_retry(device: &SonosDevice) -> Result<()> {
    retry_operation(|| device.stop()).await
}

pub async fn seek_with_retry(device: &SonosDevice, request: sonos::av_transport::SeekRequest) -> Result<()> {
    retry_operation(|| device.seek(request.clone())).await
}

pub async fn set_av_transport_uri_with_retry(device: &SonosDevice, uri: &str, metadata: Option<TrackMetaData>) -> Result<()> {
    retry_operation(|| device.set_av_transport_uri(uri, metadata.clone())).await
}
