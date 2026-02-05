#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "boto3>=1.35",
#     "requests>=2.32",
# ]
# ///
"""
Migrate ReiTunes music files from Azure Blob Storage to OVHcloud S3.

This script:
1. Reads the SQLite database to get all library items
2. For items with Azure paths (containing '/'), downloads from Azure
3. Uploads to OVHcloud S3 with a unique filename
4. Creates LibraryItemFilePathChangedEvent to update the database

Environment variables required:
- S3_ENDPOINT: OVHcloud S3 endpoint (e.g., https://s3.ca-east-tor.io.cloud.ovh.net)
- S3_BUCKET: S3 bucket name
- S3_ACCESS_KEY: OVHcloud access key
- S3_SECRET_KEY: OVHcloud secret key

Optional:
- S3_PREFIX: Directory prefix in bucket (e.g., "dev" or "prod")
- DB_PATH: Path to SQLite database (default: ./reitunes-library.db)
- DRY_RUN: Set to "true" to simulate without making changes
"""

import json
import os
import socket
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import boto3
import requests
from botocore.config import Config

# Azure storage URL for downloading files
AZURE_BASE_URL = "https://reitunes.blob.core.windows.net/music"


@dataclass
class LibraryItem:
    """Represents a library item from the database."""

    id: str
    name: str
    file_path: str


def get_machine_name() -> str:
    """Get the machine name for event metadata."""
    return socket.gethostname()


def get_utc_timestamp() -> str:
    """Get current UTC timestamp in the format expected by the database."""
    # Format: 2024-01-15T10:30:45
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def load_library_items(conn: sqlite3.Connection) -> list[LibraryItem]:
    """Load all library items from events in the database."""
    cursor = conn.cursor()

    # Load all events ordered by creation time
    cursor.execute("""
        SELECT AggregateId, Serialized
        FROM events
        WHERE AggregateType = 'LibraryItem'
        ORDER BY CreatedTimeUtc
    """)

    # Build items from events
    items: dict[str, dict] = {}

    for aggregate_id, serialized in cursor.fetchall():
        event = json.loads(serialized)
        event_type = event.get("$type")

        if event_type == "LibraryItemCreatedEvent":
            items[aggregate_id] = {
                "id": aggregate_id,
                "name": event.get("Name", ""),
                "file_path": event.get("FilePath", ""),
            }
        elif event_type == "LibraryItemDeletedEvent":
            items.pop(aggregate_id, None)
        elif event_type == "LibraryItemFilePathChangedEvent":
            if aggregate_id in items:
                items[aggregate_id]["file_path"] = event.get("NewFilePath", "")
        elif event_type == "LibraryItemNameChangedEvent":
            if aggregate_id in items:
                items[aggregate_id]["name"] = event.get("NewName", "")

    return [
        LibraryItem(id=item["id"], name=item["name"], file_path=item["file_path"])
        for item in items.values()
    ]


def download_from_azure(file_path: str) -> bytes:
    """Download a file from Azure Blob Storage."""
    url = f"{AZURE_BASE_URL}/{quote(file_path)}"
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    return response.content


def generate_unique_filename(original: str) -> str:
    """Generate a unique filename with timestamp to avoid collisions."""
    path = Path(original)
    stem = path.stem
    ext = path.suffix
    timestamp = int(time.time() * 1000)
    return f"{stem}-{timestamp}{ext}"


def upload_to_s3(
    s3_client,
    bucket: str,
    data: bytes,
    filename: str,
    content_type: str,
    prefix: str | None = None,
) -> str:
    """Upload data to S3 and return the key (filename only, not including prefix)."""
    # Construct the S3 key with prefix if provided
    s3_key = f"{prefix}/{filename}" if prefix else filename

    s3_client.put_object(
        Bucket=bucket,
        Key=s3_key,
        Body=data,
        ContentType=content_type,
    )
    # Return just the filename - DB stores relative path without prefix
    return filename


def guess_content_type(filename: str) -> str:
    """Guess the MIME type based on file extension."""
    ext = Path(filename).suffix.lower()
    content_types = {
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".aac": "audio/aac",
    }
    return content_types.get(ext, "application/octet-stream")


def save_file_path_changed_event(
    conn: sqlite3.Connection, item_id: str, new_file_path: str
) -> None:
    """Save a LibraryItemFilePathChangedEvent to the database."""
    event_id = str(uuid.uuid4())
    created_time = get_utc_timestamp()
    machine_name = get_machine_name()

    # Serialize the event in the expected format
    event_data = {"$type": "LibraryItemFilePathChangedEvent", "NewFilePath": new_file_path}
    serialized = json.dumps(event_data)

    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO events (Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (event_id, item_id, "LibraryItem", created_time, machine_name, serialized),
    )


def main():
    # Configuration from environment
    s3_endpoint = os.environ.get("S3_ENDPOINT")
    s3_bucket = os.environ.get("S3_BUCKET")
    s3_prefix = os.environ.get("S3_PREFIX")  # Optional: directory prefix (e.g., "dev" or "prod")
    s3_access_key = os.environ.get("S3_ACCESS_KEY")
    s3_secret_key = os.environ.get("S3_SECRET_KEY")
    db_path = os.environ.get("DB_PATH", "./reitunes-library.db")
    dry_run = os.environ.get("DRY_RUN", "").lower() == "true"

    # Validate configuration
    if not all([s3_endpoint, s3_bucket, s3_access_key, s3_secret_key]):
        print("Error: Missing required environment variables.")
        print("Required: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY")
        sys.exit(1)

    if not Path(db_path).exists():
        print(f"Error: Database not found at {db_path}")
        sys.exit(1)

    if dry_run:
        print("=== DRY RUN MODE - No changes will be made ===\n")

    if s3_prefix:
        print(f"S3 prefix: {s3_prefix}")
        print(f"Files will be uploaded to: s3://{s3_bucket}/{s3_prefix}/\n")

    # Initialize S3 client for OVHcloud
    s3_client = boto3.client(
        "s3",
        endpoint_url=s3_endpoint,
        aws_access_key_id=s3_access_key,
        aws_secret_access_key=s3_secret_key,
        config=Config(signature_version="s3v4"),
        region_name="ca-east-tor",
    )

    # Connect to database
    conn = sqlite3.connect(db_path)

    try:
        # Load library items
        items = load_library_items(conn)
        print(f"Loaded {len(items)} library items from database")

        # Filter items that need migration (Azure paths contain '/')
        items_to_migrate = [item for item in items if "/" in item.file_path]
        print(f"Found {len(items_to_migrate)} items to migrate (with '/' in file_path)")

        if not items_to_migrate:
            print("No items need migration. Done!")
            return

        # Migrate each item
        success_count = 0
        error_count = 0
        errors: list[tuple[str, str]] = []

        for i, item in enumerate(items_to_migrate, 1):
            print(f"\n[{i}/{len(items_to_migrate)}] Processing: {item.name}")
            print(f"  Azure path: {item.file_path}")

            try:
                # Download from Azure
                print("  Downloading from Azure...")
                if not dry_run:
                    data = download_from_azure(item.file_path)
                    print(f"  Downloaded {len(data)} bytes")
                else:
                    print("  [DRY RUN] Would download from Azure")
                    data = b""

                # Generate unique filename (just the filename, not the full path)
                original_filename = Path(item.file_path).name
                new_filename = generate_unique_filename(original_filename)
                print(f"  New filename: {new_filename}")

                # Upload to S3
                content_type = guess_content_type(new_filename)
                s3_key_display = f"{s3_prefix}/{new_filename}" if s3_prefix else new_filename
                print(f"  Uploading to S3: {s3_key_display} ({content_type})...")
                if not dry_run:
                    upload_to_s3(s3_client, s3_bucket, data, new_filename, content_type, s3_prefix)
                    print("  Uploaded successfully")
                else:
                    print("  [DRY RUN] Would upload to S3")

                # Save file path changed event
                print("  Saving event to database...")
                if not dry_run:
                    save_file_path_changed_event(conn, item.id, new_filename)
                    conn.commit()
                    print("  Event saved")
                else:
                    print("  [DRY RUN] Would save event")

                success_count += 1

            except requests.exceptions.HTTPError as e:
                error_msg = f"HTTP error downloading: {e}"
                print(f"  ERROR: {error_msg}")
                errors.append((item.name, error_msg))
                error_count += 1

            except Exception as e:
                error_msg = str(e)
                print(f"  ERROR: {error_msg}")
                errors.append((item.name, error_msg))
                error_count += 1

        # Summary
        print("\n" + "=" * 50)
        print("MIGRATION COMPLETE")
        print("=" * 50)
        print(f"Successfully migrated: {success_count}")
        print(f"Errors: {error_count}")

        if errors:
            print("\nFailed items:")
            for name, error in errors:
                print(f"  - {name}: {error}")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
