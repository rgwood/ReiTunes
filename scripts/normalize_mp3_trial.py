#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.40", "boto3-stubs[s3]>=1.40"]
# ///
"""Prepare, apply or restore up to five MP3s. Never scans the whole library."""

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import shlex
import shutil
import subprocess
from typing import Any
import urllib.parse
import urllib.request

import boto3
from botocore.config import Config

TARGET_LUFS = -18.0
MAX_PEAK_DB = -1.0
MP3_STEP_DB = 20 * math.log10(2**0.25)
MAX_BYTES = 128 * 1024 * 1024
POLICY = "mp3-r128-minus18-truepeak-minus1-v1"


class SilentAudio(ValueError):
    """A silent recording has no finite gain target."""


def run(*args: str) -> str:
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.decode(errors='replace')[-2000:]}")
    return result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace")


def measure(path: Path) -> dict[str, float]:
    output = run("ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-xerror", "-i", str(path),
                 "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-")
    summary = output.rsplit("Summary:", 1)[-1]
    if re.search(r"^\s*Peak:\s+-inf\b", summary, re.MULTILINE):
        raise SilentAudio("Recording is silent")

    def value(label: str) -> float:
        match = re.search(rf"^\s*{label}:\s+([-+\d.inf]+)", summary, re.MULTILINE)
        if not match or not math.isfinite(number := float(match[1])):
            raise ValueError(f"Missing or non-finite {label} in loudness measurement")
        return number

    return {"lufs": value("I"), "peak_db": value("Peak")}


def gain_steps(lufs: float, peak_db: float) -> int:
    # Leave 0.1 dB for the scanner's rounded peak report. MP3 gain is quantized.
    return min(round((TARGET_LUFS - lufs) / MP3_STEP_DB),
               math.floor((MAX_PEAK_DB - 0.1 - peak_db) / MP3_STEP_DB))


def probe(path: Path) -> dict[str, Any]:
    return json.loads(run("ffprobe", "-v", "error", "-select_streams", "a", "-count_packets", "-show_streams",
                          "-show_format", "-of", "json", str(path)))


def audio_hash(path: Path) -> str:
    # Check exact decoded samples. MP3Gain can change silent padding frame bits
    # during undo even when the decoded audio is identical.
    return run("ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:a:0",
               "-c:a", "pcm_f32le", "-f", "hash", "-hash", "sha256", "-").strip()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: Any) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def config(path: Path) -> dict[str, str]:
    # Read dotenv values as data; never source or execute the file.
    result = {}
    for line in path.read_text().splitlines():
        key, separator, raw = line.removeprefix("export ").partition("=")
        if separator and key.strip().startswith("S3_"):
            tokens = shlex.split(raw, comments=True)
            if len(tokens) != 1:
                raise ValueError(f"Expected a literal value for {key}")
            result[key.strip()] = tokens[0]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "apply", "restore"])
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--title", action="append", default=[])
    parser.add_argument("--mp3gain", default="mp3gain")
    args = parser.parse_args()
    settings = config(args.env_file)
    s3 = boto3.client("s3", endpoint_url=settings["S3_ENDPOINT"], region_name="ca-east-tor",
                      aws_access_key_id=settings["S3_ACCESS_KEY"],
                      aws_secret_access_key=settings["S3_SECRET_KEY"],
                      config=Config(signature_version="s3v4", connect_timeout=15, read_timeout=60,
                                    retries={"max_attempts": 2},
                                    request_checksum_calculation="when_required",
                                    response_checksum_validation="when_required"))
    bucket = settings["S3_BUCKET"]
    prefix = settings.get("S3_PREFIX", "").strip("/")
    scope = {"endpoint": settings["S3_ENDPOINT"], "bucket": bucket, "prefix": prefix}
    folder: Path = args.directory.resolve()
    manifest_path = folder / "manifest.json"
    folder.mkdir(parents=True, exist_ok=True)

    def download(key: str, etag: str | None = None) -> bytes:
        response = s3.get_object(Bucket=bucket, Key=key, **({"IfMatch": etag} if etag else {}))
        with response["Body"] as body:
            data = body.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("Trial file exceeds 128 MiB")
        return data

    if args.mode == "prepare":
        if manifest_path.exists() or any(folder.glob("*-original.mp3")):
            raise ValueError("Use a fresh trial directory; never overwrite original backups")
        if not args.inventory or not 1 <= len(args.title) <= 5 or len(set(args.title)) != len(args.title):
            raise ValueError("Select 1 to 5 distinct exact titles and supply an inventory")
        inventory = json.loads(args.inventory.read_text())
        manifest: dict[str, Any] = {"scope": scope, "policy": POLICY, "tracks": []}
        for number, title in enumerate(args.title):
            matches = [item for item in inventory if item["Name"] == title]
            if len(matches) != 1:
                raise ValueError(f"Expected exactly one match for {title!r}")
            item = matches[0]
            source = item["FilePath"]
            if Path(source).suffix.lower() != ".mp3" or not 0 < item.get("Seconds", 0) < 900:
                raise ValueError("Only known MP3s under 15 minutes are eligible")
            if "/" in source or "\\" in source:
                raise ValueError("Trial expects flat storage filenames")
            key = f"{prefix}/{source}" if prefix else source
            head = s3.head_object(Bucket=bucket, Key=key)
            if head.get("Metadata", {}).get("reitunes-normalization"):
                raise ValueError("File is already normalized; refusing to compound gain")
            data = download(key, head["ETag"])
            original, adjusted = folder / f"{number}-original.mp3", folder / f"{number}-adjusted.mp3"
            original.write_bytes(data)
            original.chmod(0o400)
            adjusted.write_bytes(data)
            details = probe(original)
            streams = details["streams"]
            if len(streams) != 1 or streams[0]["codec_name"] != "mp3":
                raise ValueError("Expected one MP3 audio stream")
            seconds = float(details["format"]["duration"])
            if not 0 < seconds < 900:
                raise ValueError("Actual duration is outside the trial limit")
            before = measure(original)
            steps = gain_steps(before["lufs"], before["peak_db"])
            if steps == 0:
                raise ValueError(f"{title} needs no gain change; choose a different trial song")
            run(args.mp3gain, "-q", "-g", str(steps), str(adjusted))
            after = measure(adjusted)
            if after["peak_db"] > MAX_PEAK_DB or abs(after["lufs"] - before["lufs"] - steps * MP3_STEP_DB) > 0.2:
                raise ValueError("Output loudness or peak does not match the planned adjustment")
            new_details = probe(adjusted)
            for field in ("codec_name", "sample_rate", "channels", "duration"):
                if streams[0].get(field) != new_details["streams"][0].get(field):
                    raise ValueError(f"Audio property changed: {field}")
            undo = folder / f"{number}-undo-check.mp3"
            shutil.copyfile(adjusted, undo)
            run(args.mp3gain, "-q", "-u", str(undo))
            if audio_hash(original) != audio_hash(undo):
                raise ValueError("MP3Gain undo did not restore identical decoded audio samples")
            undo.unlink()
            properties = {k: head[k] for k in ("ContentType", "ContentDisposition", "ContentEncoding",
                          "ContentLanguage", "CacheControl", "Metadata", "StorageClass") if k in head}
            track = {"title": title, "key": key, "original_etag": head["ETag"],
                     "original_sha256": digest(data), "adjusted_sha256": digest(adjusted.read_bytes()),
                     "original": original.name, "adjusted": adjusted.name, "properties": properties,
                     "before": before, "after": after, "gain_db": steps * MP3_STEP_DB,
                     "seconds": seconds, "undo_verified": True, "state": "prepared"}
            manifest["tracks"].append(track)
            save(manifest_path, manifest)
            print(json.dumps({k: track[k] for k in ("title", "before", "after", "gain_db", "undo_verified")}), flush=True)
        manifest["complete"] = True
        save(manifest_path, manifest)
        return

    manifest = json.loads(manifest_path.read_text())
    if manifest["scope"] != scope or manifest["policy"] != POLICY or not manifest.get("complete"):
        raise ValueError("Incomplete trial or mismatched storage/policy")
    if not 1 <= len(manifest["tracks"]) <= 5:
        raise ValueError("This script is limited to five songs")
    # Versioned buckets would retain permanent duplicates; don't silently create them.
    if "Status" in s3.get_bucket_versioning(Bucket=bucket):
        raise ValueError("Trial expects an unversioned bucket")
    for track in manifest["tracks"]:
        restoring = args.mode == "restore"
        desired = "original" if restoring else "adjusted"
        data = (folder / track[desired]).read_bytes()
        if digest(data) != track[f"{desired}_sha256"]:
            raise ValueError("Local file changed since verification")
        current = s3.head_object(Bucket=bucket, Key=track["key"])
        current_data = download(track["key"], current["ETag"])
        current_hash = digest(current_data)
        if current_hash == digest(data):
            print(f"Already {desired}: {track['title']}", flush=True)
            continue
        expected = track["adjusted_sha256" if restoring else "original_sha256"]
        if current_hash != expected:
            raise ValueError("Cloud file changed outside this trial; refusing to overwrite it")
        properties = dict(track["properties"])
        if not restoring:
            properties["Metadata"] = {**properties.get("Metadata", {}), "reitunes-normalization": POLICY,
                                      "reitunes-original-sha256": track["original_sha256"]}
            properties["CacheControl"] = "no-cache"
        track["state"] = "restoring" if restoring else "uploading"
        save(manifest_path, manifest)
        s3.put_object(Bucket=bucket, Key=track["key"], Body=data, ACL="public-read",
                      IfMatch=current["ETag"], ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode(),
                      **properties)
        if digest(download(track["key"])) != digest(data):
            raise ValueError("Uploaded object failed full SHA-256 verification")
        # Sonos needs anonymous access and byte-range seeking, using the same URL as before.
        host = urllib.parse.urlparse(settings["S3_ENDPOINT"]).netloc
        url = f"https://{bucket}.{host}/" + urllib.parse.quote(track["key"], safe="/")
        request = urllib.request.Request(url, headers={"Range": "bytes=0-1023", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 206 or response.read(1024) != data[:1024]:
                raise ValueError("Public byte-range playback check failed")
        track["state"] = "restored" if restoring else "applied"
        save(manifest_path, manifest)
        print(f"{track['state']}: {track['title']} (full object and public seeking verified)", flush=True)


if __name__ == "__main__":
    main()
