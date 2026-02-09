use anyhow::{Context, Result};
use aws_sdk_s3::primitives::ByteStream;
use std::path::Path;
use tracing::info;

/// S3-compatible object storage (OVHcloud, AWS, etc.)
pub struct S3Storage {
    client: aws_sdk_s3::Client,
    bucket: String,
    prefix: Option<String>,  // e.g., "dev" or "prod" for directory separation
    base_url: String,        // Pre-computed base URL including prefix
}

impl S3Storage {
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

        // Compute the S3 key (with prefix if configured)
        let s3_key = match &self.prefix {
            Some(prefix) => format!("{}/{}", prefix, unique_name),
            None => unique_name.clone(),
        };

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
