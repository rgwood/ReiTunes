#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.40", "boto3-stubs[s3]>=1.40"]
# ///
"""Restore explicitly selected batch receipts. Checks only unless --apply is supplied."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

from normalize_mp3_trial import MAX_BYTES, config, digest, save


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path, nargs="+")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    settings = config(args.env_file)
    s3 = boto3.client("s3", endpoint_url=settings["S3_ENDPOINT"], region_name="ca-east-tor",
                      aws_access_key_id=settings["S3_ACCESS_KEY"], aws_secret_access_key=settings["S3_SECRET_KEY"],
                      config=Config(signature_version="s3v4", connect_timeout=15, read_timeout=60,
                                    request_checksum_calculation="when_required",
                                    response_checksum_validation="when_required"))
    for path in args.receipt:
        record = json.loads(path.read_text())
        scope = json.loads((path.parent.parent / "scope.json").read_text())
        expected = {"endpoint": settings["S3_ENDPOINT"], "bucket": settings["S3_BUCKET"],
                    "prefix": settings.get("S3_PREFIX", "").strip("/")}
        if any(scope[k] != value for k, value in expected.items()):
            raise ValueError("Receipt belongs to a different storage scope")
        original = (path.parent / "original.mp3").read_bytes()
        if digest(original) != record["original_sha256"]:
            raise ValueError("Original backup failed checksum verification")
        head = s3.head_object(Bucket=scope["bucket"], Key=record["key"])
        response = s3.get_object(Bucket=scope["bucket"], Key=record["key"], IfMatch=head["ETag"])
        with response["Body"] as body:
            current = body.read(MAX_BYTES + 1)
        if digest(current) == record["original_sha256"]:
            print(f"Already restored: {record['title']}")
            continue
        if digest(current) != record["adjusted_sha256"]:
            raise ValueError("Cloud object changed outside this batch; refusing to overwrite it")
        if not args.apply:
            print(f"Ready to restore: {record['title']}")
            continue
        properties: dict[str, Any] = record["properties"]
        s3.put_object(Bucket=scope["bucket"], Key=record["key"], Body=original, ACL="public-read",
                      IfMatch=head["ETag"], ContentMD5=base64.b64encode(hashlib.md5(original).digest()).decode(),
                      **properties)
        response = s3.get_object(Bucket=scope["bucket"], Key=record["key"])
        with response["Body"] as body:
            restored = body.read(MAX_BYTES + 1)
        if digest(restored) != record["original_sha256"]:
            raise ValueError("Restored cloud object failed checksum verification")
        record["state"] = "restored"
        save(path, record)
        print(f"Restored and verified: {record['title']}")


if __name__ == "__main__":
    main()
