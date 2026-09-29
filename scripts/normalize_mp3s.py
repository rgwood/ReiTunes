#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.40", "boto3-stubs[s3]>=1.40"]
# ///
"""Normalize short MP3s in place, with durable local receipts and original backups.

Requires the adjacent normalize_mp3_trial.py helpers. Without --apply, prepares
verified local files only. Re-running resumes interrupted work and skips files
already processed with this policy. No cloud duplicates or re-encoding.
"""

import argparse
import base64
from collections import Counter
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import time
from typing import Any
import urllib.parse
import urllib.request

import boto3
from botocore.config import Config

from normalize_mp3_trial import (
    MAX_BYTES, MAX_PEAK_DB, MP3_STEP_DB, POLICY, SilentAudio, audio_hash, config, digest,
    gain_steps, measure, probe, run, save,
)


def eligible(item: dict[str, Any]) -> bool:
    duration = item.get("Seconds")
    return (Path(item["FilePath"]).suffix.lower() == ".mp3"
            and isinstance(duration, (int, float)) and 0 < duration < 900)


def validate_source(source: str) -> None:
    if not source or "/" in source or "\\" in source or Path(source).suffix.lower() != ".mp3":
        raise ValueError("Expected a flat MP3 storage filename")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--mp3gain", default="mp3gain")
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=4)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    folder: Path = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    # A second invocation must not race the first or overwrite its backups.
    with (folder / "batch.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(args, folder)


def execute(args: argparse.Namespace, folder: Path) -> None:
    settings = config(args.env_file)
    bucket = settings["S3_BUCKET"]
    prefix = settings.get("S3_PREFIX", "").strip("/")
    scope = {"endpoint": settings["S3_ENDPOINT"], "bucket": bucket, "prefix": prefix, "policy": POLICY}
    scope_path = folder / "scope.json"
    if scope_path.exists() and json.loads(scope_path.read_text()) != scope:
        raise ValueError("This batch directory belongs to a different storage scope or policy")
    save(scope_path, scope)
    s3 = boto3.client("s3", endpoint_url=settings["S3_ENDPOINT"], region_name="ca-east-tor",
                      aws_access_key_id=settings["S3_ACCESS_KEY"], aws_secret_access_key=settings["S3_SECRET_KEY"],
                      config=Config(signature_version="s3v4", connect_timeout=15, read_timeout=60,
                                    retries={"max_attempts": 3}, max_pool_connections=16,
                                    request_checksum_calculation="when_required",
                                    response_checksum_validation="when_required"))
    if args.apply and "Status" in s3.get_bucket_versioning(Bucket=bucket):
        raise ValueError("Refusing to create permanent duplicate versions in a versioned bucket")
    run(args.mp3gain, "-v")
    inventory = json.loads(args.inventory.read_text())
    # Shared file paths are processed once. Shorter tracks first gives quick feedback.
    items = sorted({item["FilePath"]: item for item in inventory if eligible(item)}.values(),
                   key=lambda item: item["Seconds"])
    if args.limit is not None:
        if args.limit < 1:
            raise ValueError("Limit must be positive")
        items = items[:args.limit]
    save(folder / "inventory.json", inventory)

    def download(key: str, etag: str) -> bytes:
        response = s3.get_object(Bucket=bucket, Key=key, IfMatch=etag)
        with response["Body"] as body:
            data = body.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("File exceeds 128 MiB")
        return data

    def verify_public(key: str, expected: bytes) -> None:
        host = urllib.parse.urlparse(settings["S3_ENDPOINT"]).netloc
        url = f"https://{bucket}.{host}/" + urllib.parse.quote(key, safe="/")
        request = urllib.request.Request(url, headers={"Range": "bytes=0-1023", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 206 or response.read(1024) != expected[:1024]:
                raise ValueError("Public byte-range playback check failed")

    def process(item: dict[str, Any]) -> dict[str, Any]:
        source = item["FilePath"]
        validate_source(source)
        key = f"{prefix}/{source}" if prefix else source
        directory = folder / hashlib.sha256(key.encode()).hexdigest()
        directory.mkdir(exist_ok=True)
        receipt_path = directory / "receipt.json"
        record: dict[str, Any] = json.loads(receipt_path.read_text()) if receipt_path.exists() else {
            "title": item["Name"], "key": key, "state": "pending", "policy": POLICY,
        }
        if record["key"] != key or record["policy"] != POLICY:
            raise ValueError("Receipt identity mismatch")
        if "Undo did not restore" in record.get("error", ""):
            # A few old files have tag layouts that MP3Gain cannot read back
            # using its default APE format. Retry from the original with ID3 undo.
            record["undo_tag_format"] = "id3"
        record.pop("error", None)
        original, adjusted = directory / "original.mp3", directory / "adjusted.mp3"

        def persist() -> None:
            record["updated_at"] = time.time()
            save(receipt_path, record)

        def verify_applied(head: Mapping[str, Any]) -> None:
            uploaded = download(key, head["ETag"])
            if digest(uploaded) != record["adjusted_sha256"]:
                raise ValueError("Uploaded object failed SHA-256 verification")
            verify_public(key, uploaded)
            record["state"] = "applied"
            record["applied_etag"] = head["ETag"]
            record["public_ranges_verified"] = True
            persist()
            adjusted.unlink(missing_ok=True)

        try:
            head = s3.head_object(Bucket=bucket, Key=key)
            if head.get("Metadata", {}).get("reitunes-normalization"):
                if record["state"] == "uploading":
                    verify_applied(head)
                elif record["state"] == "applied" and head["ETag"] != record["applied_etag"]:
                    raise ValueError("Normalized object changed after verification")
                elif record["state"] != "applied":
                    record["state"] = "already_normalized"
                    persist()
                return record
            if record["state"] in ("applied", "already_normalized"):
                raise ValueError("Previously normalized object was externally replaced; use a new batch directory")
            if record["state"] in ("unchanged", "silent") and head["ETag"] == record["original_etag"]:
                return record
            if "original_etag" in record and head["ETag"] != record["original_etag"]:
                raise ValueError("Cloud original changed since this batch started")
            if head["ContentLength"] > MAX_BYTES:
                raise ValueError("File exceeds 128 MiB")

            if not original.exists():
                data = download(key, head["ETag"])
                record["original_etag"] = head["ETag"]
                record["original_sha256"] = digest(data)
                record["properties"] = {k: head[k] for k in ("ContentType", "ContentDisposition", "ContentEncoding",
                                         "ContentLanguage", "CacheControl", "Metadata", "StorageClass") if k in head}
                # Persist identity before creating the backup, so a crash cannot
                # confuse old local audio with a new object at the same key.
                persist()
                temporary = directory / "original.tmp"
                temporary.write_bytes(data)
                temporary.replace(original)
                original.chmod(0o400)
            if digest(original.read_bytes()) != record["original_sha256"]:
                raise ValueError("Original backup checksum mismatch")

            if record["state"] not in ("prepared", "uploading"):
                details = probe(original)
                streams = details["streams"]
                if len(streams) != 1 or streams[0]["codec_name"] != "mp3":
                    raise ValueError("Expected one MP3 audio stream")
                seconds = float(details["format"]["duration"])
                if not 0 < seconds < 900:
                    raise ValueError("Actual duration is outside the under-15-minute limit")
                try:
                    before = measure(original)
                except SilentAudio:
                    record["state"] = "silent"
                    persist()
                    original.unlink()
                    return record
                steps = gain_steps(before["lufs"], before["peak_db"])
                record.update(before=before, seconds=seconds, gain_db=steps * MP3_STEP_DB)
                if steps == 0:
                    record.update(state="unchanged", after=before)
                    persist()
                    # Cloud audio is unchanged, so there is nothing to roll back.
                    original.unlink()
                    return record
                shutil.copyfile(original, adjusted)
                tag_options = ["-s", "i"] if record.get("undo_tag_format") == "id3" else []
                # Old ReplayGain/undo tags must not describe a different baseline.
                # Descriptive tags and artwork are retained; the original is backed up.
                run(args.mp3gain, "-q", *tag_options, "-s", "d", str(adjusted))
                run(args.mp3gain, "-q", *tag_options, "-g", str(steps), str(adjusted))
                after = measure(adjusted)
                if after["peak_db"] > MAX_PEAK_DB or abs(after["lufs"] - before["lufs"] - steps * MP3_STEP_DB) > 0.2:
                    raise ValueError("Output loudness or peak differs from the planned adjustment")
                new_details = probe(adjusted)
                # Some MP3s have no duration header: ffprobe estimates using file
                # size, so appending undo tags changes the estimate by milliseconds.
                # Compare actual packet counts; the undo check also hashes every sample.
                for field in ("codec_name", "sample_rate", "channels", "nb_read_packets"):
                    if streams[0].get(field) != new_details["streams"][0].get(field):
                        raise ValueError(f"Audio property changed: {field}")
                for tag in ("title", "artist", "album", "track", "date"):
                    if details["format"].get("tags", {}).get(tag) != new_details["format"].get("tags", {}).get(tag):
                        raise ValueError(f"Descriptive tag changed: {tag}")
                undo = directory / "undo-check.mp3"
                shutil.copyfile(adjusted, undo)
                run(args.mp3gain, "-q", *tag_options, "-u", str(undo))
                if audio_hash(original) != audio_hash(undo):
                    raise ValueError("Undo did not restore identical decoded audio samples")
                undo.unlink()
                record.update(state="prepared", after=after, adjusted_sha256=digest(adjusted.read_bytes()), undo_verified=True)
                persist()
            if not args.apply:
                return record
            data = adjusted.read_bytes()
            if digest(data) != record["adjusted_sha256"]:
                raise ValueError("Adjusted file changed since verification")
            current = s3.head_object(Bucket=bucket, Key=key)
            if current["ETag"] != record["original_etag"]:
                raise ValueError("Cloud file changed during preparation; refusing to overwrite it")
            properties: dict[str, Any] = dict(record["properties"])
            properties["Metadata"] = {**properties.get("Metadata", {}), "reitunes-normalization": POLICY,
                                      "reitunes-original-sha256": record["original_sha256"]}
            properties["CacheControl"] = "no-cache"
            record["state"] = "uploading"
            persist()
            s3.put_object(Bucket=bucket, Key=key, Body=data, ACL="public-read", IfMatch=current["ETag"],
                          ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode(), **properties)
            verify_applied(s3.head_object(Bucket=bucket, Key=key))
        except Exception as error:
            # Keep the resumable state, especially after an uncertain upload.
            record["error"] = f"{type(error).__name__}: {error}"
            persist()
        return record

    started = time.time()
    print(json.dumps({"eligible": len(items), "library_tracks": len(inventory), "apply": args.apply,
                      "workers": args.workers, "policy": POLICY}), flush=True)
    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(process, item): item for item in items}
        for future in as_completed(futures):
            try:
                record = future.result()
            except Exception as error:
                record = {"title": futures[future]["Name"], "state": "pending", "error": str(error)}
            results.append(record)
            counts = dict(Counter("error" if r.get("error") else r["state"] for r in results))
            summary = {"completed": len(results), "total": len(items), "counts": counts,
                       "elapsed_seconds": round(time.time() - started), "last_title": record["title"]}
            if record.get("error"):
                print(json.dumps({"title": record["title"], "error": record["error"]}), flush=True)
            if len(results) % 20 == 0 or len(results) == len(items):
                print(json.dumps(summary), flush=True)
            save(folder / "progress.json", summary)
    save(folder / "results.json", results)
    if any(record.get("error") for record in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
