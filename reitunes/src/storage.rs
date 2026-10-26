use anyhow::{ensure, Context, Result};
use aws_sdk_s3::primitives::ByteStream;
use std::{collections::HashMap, path::Path};
use tracing::info;

/// What a HEAD request says about a stored audio object.
#[derive(Debug, Clone)]
pub struct StoredObject {
    pub etag: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
}

/// S3-compatible object storage (OVHcloud, AWS, etc.)
pub struct S3Storage {
    client: aws_sdk_s3::Client,
    bucket: String,
    prefix: Option<String>,  // e.g., "dev" or "prod" for directory separation
    base_url: String,        // Pre-computed base URL including prefix
}

impl S3Storage {
    pub fn scope(&self) -> &str {
        &self.base_url
    }

    /// Delete only an exact relative library path in this storage prefix.
    pub async fn delete(&self, file_path: &str) -> Result<()> {
        ensure!(valid_file_path(file_path), "Refusing to delete an invalid storage path");
        // DeleteObject only creates a delete marker in a versioned bucket. Do
        // not record that as reclaimed storage; it needs a version-aware purge.
        let versioning = self.client.get_bucket_versioning().bucket(&self.bucket).send().await?;
        ensure!(versioning.status().is_none(), "Storage cleanup requires an unversioned bucket");
        self.client.delete_object().bucket(&self.bucket).key(self.key(file_path)).send().await
            .context("Failed to delete audio from object storage")?;
        Ok(())
    }

    fn key(&self, file_path: &str) -> String {
        match &self.prefix {
            Some(prefix) => format!("{prefix}/{file_path}"),
            None => file_path.to_string(),
        }
    }

    pub async fn head(&self, file_path: &str) -> Result<StoredObject> {
        ensure!(valid_file_path(file_path), "Refusing to read an invalid storage path");
        let head = self.client.head_object().bucket(&self.bucket).key(self.key(file_path)).send().await
            .context("Failed to read audio object metadata")?;
        Ok(StoredObject {
            etag: head.e_tag().context("Audio object has no ETag")?.to_string(),
            size: head.content_length().unwrap_or_default(),
            content_type: head.content_type().map(str::to_string),
            metadata: head.metadata().cloned().unwrap_or_default(),
        })
    }

    /// Download an object only if it still has this ETag.
    pub async fn download(&self, file_path: &str, etag: &str, max_bytes: i64) -> Result<Vec<u8>> {
        ensure!(valid_file_path(file_path), "Refusing to read an invalid storage path");
        let response = self.client.get_object().bucket(&self.bucket).key(self.key(file_path)).if_match(etag)
            .send().await.context("Failed to download audio object")?;
        ensure!(response.content_length().unwrap_or_default() <= max_bytes, "Audio object is too large");
        let data = response.body.collect().await.context("Failed to read audio object")?.to_vec();
        ensure!(data.len() as i64 <= max_bytes, "Audio object is too large");
        Ok(data)
    }

    /// Replace an object in place, failing if it changed since `etag` was read.
    /// The URL stays the same, so browsers and Sonos pick up the new audio.
    pub async fn replace(
        &self,
        file_path: &str,
        etag: &str,
        data: Vec<u8>,
        content_type: &str,
        metadata: HashMap<String, String>,
    ) -> Result<()> {
        ensure!(valid_file_path(file_path), "Refusing to replace an invalid storage path");
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(self.key(file_path))
            .if_match(etag)
            .body(ByteStream::from(data))
            .content_type(content_type)
            .cache_control("no-cache")
            .set_metadata(Some(metadata))
            .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
            .send()
            .await
            .context("Failed to replace audio object")?;
        Ok(())
    }

    pub async fn new(
        endpoint: &str,
        bucket: &str,
        prefix: Option<&str>,
        access_key: &str,
        secret_key: &str,
    ) -> Result<Self> {
        let credentials = aws_sdk_s3::config::Credentials::new(
            access_key,
            secret_key,
            None,
            None,
            "reitunes",
        );

        let config = aws_sdk_s3::Config::builder()
            .endpoint_url(endpoint)
            .region(aws_sdk_s3::config::Region::new("ca-east-tor"))
            .credentials_provider(credentials)
            .force_path_style(true) // Required for OVHcloud S3 API calls
            .behavior_version_latest()
            .build();

        let client = aws_sdk_s3::Client::from_conf(config);

        // Construct base URL for public access using virtual-host style
        // OVHcloud requires virtual-host style for public URLs: bucket.endpoint/key
        // e.g., https://reitunes.s3.ca-east-tor.io.cloud.ovh.net/dev/file.mp3
        let endpoint_host = endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        let base_url = match &prefix {
            Some(p) => format!("https://{}.{}/{}", bucket, endpoint_host, p),
            None => format!("https://{}.{}", bucket, endpoint_host),
        };

        Ok(Self {
            client,
            bucket: bucket.to_string(),
            prefix: prefix.map(|s| s.to_string()),
            base_url,
        })
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

    pub async fn upload(&self, filename: &str, data: &[u8]) -> Result<String> {
        let unique_name = self.unique_filename(filename);
        let s3_key = self.key(&unique_name);

        // Guess content type from filename
        let content_type = mime_guess::from_path(&unique_name)
            .first_or_octet_stream()
            .to_string();

        info!(
            key = %s3_key,
            size = data.len(),
            content_type = %content_type,
            "Uploading file to S3"
        );

        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&s3_key)
            .body(ByteStream::from(data.to_vec()))
            .content_type(content_type)
            .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
            .send()
            .await
            .context("Failed to upload to S3")?;

        // Return just the filename (without prefix) - DB stores relative path only
        Ok(unique_name)
    }

    pub fn url(&self, file_path: &str) -> String {
        // base_url already includes the prefix, so just append the URL-encoded filename
        let encoded = urlencoding::encode(file_path);
        format!("{}/{}", self.base_url, encoded)
    }
}

pub fn valid_file_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\\') && !path.contains("://") &&
        !path.split('/').any(|part| matches!(part, "" | "." | ".."))
}
