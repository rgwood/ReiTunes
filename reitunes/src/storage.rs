use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tracing::info;

/// Storage backend trait for file storage
pub trait StorageBackend: Send + Sync {
    /// Upload a file and return the relative file path
    fn upload(&self, filename: &str, data: &[u8]) -> impl std::future::Future<Output = Result<String>> + Send;

    /// Get the URL for a file path
    fn url(&self, file_path: &str) -> String;
}

/// Local filesystem storage for development
pub struct LocalStorage {
    base_dir: PathBuf,
    base_url: String,
}

impl LocalStorage {
    pub fn new(base_dir: PathBuf, base_url: String) -> Self {
        Self { base_dir, base_url }
    }

    /// Ensure the base directory exists
    pub async fn ensure_dir(&self) -> Result<()> {
        fs::create_dir_all(&self.base_dir)
            .await
            .context("Failed to create music directory")?;
        Ok(())
    }

    /// Generate a unique filename to avoid collisions
    fn unique_filename(&self, original: &str) -> String {
        let path = Path::new(original);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = path.extension().unwrap_or_default().to_string_lossy();

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();

        if ext.is_empty() {
            format!("{}-{}", stem, timestamp)
        } else {
            format!("{}-{}.{}", stem, timestamp, ext)
        }
    }
}

impl StorageBackend for LocalStorage {
    async fn upload(&self, filename: &str, data: &[u8]) -> Result<String> {
        self.ensure_dir().await?;

        let unique_name = self.unique_filename(filename);
        let file_path = self.base_dir.join(&unique_name);

        info!(path = ?file_path, size = data.len(), "Writing file to local storage");

        let mut file = fs::File::create(&file_path)
            .await
            .context("Failed to create file")?;

        file.write_all(data)
            .await
            .context("Failed to write file data")?;

        file.flush().await.context("Failed to flush file")?;

        Ok(unique_name)
    }

    fn url(&self, file_path: &str) -> String {
        format!("{}/{}", self.base_url, file_path)
    }
}

/// Azure Blob Storage (existing backend for legacy files)
pub struct AzureStorage {
    base_url: String,
}

impl AzureStorage {
    pub fn new() -> Self {
        Self {
            base_url: "https://reitunes.blob.core.windows.net/music".to_string(),
        }
    }
}

impl Default for AzureStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl StorageBackend for AzureStorage {
    async fn upload(&self, _filename: &str, _data: &[u8]) -> Result<String> {
        anyhow::bail!("Azure upload not implemented - use LocalStorage for new uploads")
    }

    fn url(&self, file_path: &str) -> String {
        format!("{}/{}", self.base_url, file_path)
    }
}
