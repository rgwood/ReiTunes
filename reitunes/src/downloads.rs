use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::{sync::LazyLock, time::Duration};

pub type ApiError = (StatusCode, String);
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30)).build().expect("download HTTP client")
});

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Job {
    pub id: i64,
    pub url: String,
    pub dl_type: String,
    pub stage: String,
    pub download_percent: Option<f64>,
    pub error: Option<String>,
}

pub struct Downloads {
    jobs: reqwest::Url,
}

impl Downloads {
    pub fn new(endpoint: &str) -> Result<Self, ApiError> {
        let endpoint = reqwest::Url::parse(endpoint).map_err(unavailable)?;
        let jobs = endpoint.join("jobs").map_err(unavailable)?;
        Ok(Self { jobs })
    }

    pub async fn queue(&self, request: &crate::DownloadRequest) -> Result<Job, ApiError> {
        read_job(HTTP.post(self.jobs.clone()).json(request).send().await).await
    }

    pub async fn get(&self, id: i64) -> Result<Job, ApiError> {
        if id <= 0 {
            return Err((StatusCode::BAD_REQUEST, "Invalid download ID.".into()));
        }
        let mut url = self.jobs.clone();
        url.set_path(&format!("{}/{id}", url.path().trim_end_matches('/')));
        read_job(HTTP.get(url).send().await).await
    }
}

fn unavailable(error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(%error, "Downloader request failed");
    (StatusCode::BAD_GATEWAY, "Could not reach the downloader. Check progress before submitting again.".into())
}

async fn read_job(response: Result<reqwest::Response, reqwest::Error>) -> Result<Job, ApiError> {
    let response = response.map_err(unavailable)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err((StatusCode::NOT_FOUND, "Download status is no longer available. Check your library before retrying.".into()));
    }
    let response = response.error_for_status().map_err(unavailable)?;
    let job: Job = response.json().await.map_err(unavailable)?;
    if job.id <= 0 || !matches!(job.stage.as_str(), "queued" | "downloading" | "processing" | "uploading" | "importing" | "completed" | "failed") {
        return Err(unavailable("Invalid download job response"));
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::{get, post}, Json, Router};
    use serde_json::json;

    #[tokio::test]
    async fn forwards_jobs_and_reads_progress_and_failures() {
        let app = Router::new()
            .route("/worker/jobs", post(|Json(request): Json<serde_json::Value>| async move {
                assert_eq!(request, json!({"url":"https://example.com/set", "dl_type":"Audio"}));
                (StatusCode::ACCEPTED, Json(json!({"id":7,"url":"https://example.com/set","dl_type":"Audio","stage":"queued","download_percent":null,"error":null})))
            }))
            .route("/worker/jobs/7", get(|| async { Json(json!({"id":7,"url":"https://example.com/set","dl_type":"Audio","stage":"downloading","download_percent":42.5,"error":null})) }))
            .route("/worker/jobs/8", get(|| async { Json(json!({"id":8,"url":"https://example.com/set","dl_type":"Audio","stage":"failed","download_percent":null,"error":"Upload failed"})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Downloads::new(&format!("http://{}/worker/download", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let queued = client.queue(&crate::DownloadRequest { url: "https://example.com/set".into(), dl_type: "Audio".into() }).await.unwrap();
        assert_eq!(queued.id, 7);
        assert_eq!(queued.stage, "queued");
        assert_eq!(client.get(7).await.unwrap().download_percent, Some(42.5));
        assert_eq!(client.get(8).await.unwrap().error.as_deref(), Some("Upload failed"));
        assert_eq!(client.get(9).await.unwrap_err().0, StatusCode::NOT_FOUND);
        assert_eq!(client.get(0).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        server.abort();
    }
}
