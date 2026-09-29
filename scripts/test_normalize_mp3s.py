#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.40", "boto3-stubs[s3]>=1.40"]
# ///
"""Exercise replacement guards and recovery without contacting cloud storage."""
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import tempfile
from typing import Any
import unittest
from unittest.mock import patch

import normalize_mp3s as batch
from normalize_mp3_trial import POLICY, SilentAudio, digest, gain_steps, measure


class Store:
    def __init__(self) -> None:
        self.data = b"original audio"
        self.metadata: dict[str, str] = {}
        self.writes = 0
        self.fail_after_upload = False

    def get_bucket_versioning(self, **kwargs: Any) -> dict[str, Any]:
        return {}

    def head_object(self, **kwargs: Any) -> dict[str, Any]:
        return {"ETag": digest(self.data), "ContentLength": len(self.data), "Metadata": self.metadata}

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        if kwargs["IfMatch"] != digest(self.data):
            raise RuntimeError("Precondition failed")
        if self.fail_after_upload and self.writes:
            raise RuntimeError("Lost response after upload")
        return {"Body": io.BytesIO(self.data)}

    def put_object(self, **kwargs: Any) -> None:
        if kwargs["IfMatch"] != digest(self.data):
            raise RuntimeError("Precondition failed")
        self.data = kwargs["Body"]
        self.metadata = kwargs["Metadata"]
        self.writes += 1


class PublicResponse(io.BytesIO):
    status = 206


class NormalizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.store = Store()
        self.inventory = self.folder / "inventory-input.json"
        self.inventory.write_text(json.dumps([{"Name": "Song", "FilePath": "song.mp3", "Seconds": 200}]))
        self.directory = self.folder / hashlib.sha256(b"prod/song.mp3").hexdigest()
        self.directory.mkdir()
        (self.directory / "original.mp3").write_bytes(self.store.data)
        (self.directory / "adjusted.mp3").write_bytes(b"adjusted audio")
        self.receipt = {"key": "prod/song.mp3", "title": "Song", "policy": POLICY, "state": "prepared",
                        "original_etag": digest(self.store.data), "original_sha256": digest(self.store.data),
                        "adjusted_sha256": digest(b"adjusted audio"), "properties": {"ContentType": "audio/mpeg"}}
        (self.directory / "receipt.json").write_text(json.dumps(self.receipt))

    def invoke(self, apply: bool = True) -> None:
        args = ["normalize_mp3s.py", "--env-file", "unused", "--inventory", str(self.inventory),
                "--directory", str(self.folder), "--workers", "1"] + (["--apply"] if apply else [])
        settings = {"S3_ENDPOINT": "https://storage.test", "S3_BUCKET": "music", "S3_PREFIX": "prod",
                    "S3_ACCESS_KEY": "unused", "S3_SECRET_KEY": "unused"}
        with ExitStack() as stack:
            stack.enter_context(patch("sys.argv", args))
            stack.enter_context(patch.object(batch, "config", return_value=settings))
            stack.enter_context(patch.object(batch.boto3, "client", return_value=self.store))
            stack.enter_context(patch.object(batch, "run", return_value=""))
            stack.enter_context(patch.object(batch.urllib.request, "urlopen", side_effect=lambda *a, **k: PublicResponse(self.store.data)))
            stack.enter_context(redirect_stdout(io.StringIO()))
            batch.main()

    def test_peak_protection_and_known_trial_gains(self) -> None:
        self.assertEqual(gain_steps(-20.2, -8.1), 1)
        self.assertEqual(gain_steps(-17.3, -0.2), -1)
        self.assertEqual(gain_steps(-9.1, 0), -6)
        self.assertLessEqual(gain_steps(-40, -1.0), 0)

    def test_excludes_long_unknown_and_non_mp3_files(self) -> None:
        for source, seconds in [("song.m4a", 200), ("set.mp3", 900), ("set.mp3", 7200), ("song.mp3", None)]:
            self.assertFalse(batch.eligible({"FilePath": source, "Seconds": seconds}))

    def test_silence_is_not_given_an_infinite_gain(self) -> None:
        with patch("normalize_mp3_trial.run", return_value="Summary:\n I: -70.0 LUFS\n Peak: -inf dBFS"):
            with self.assertRaises(SilentAudio):
                measure(Path("silent.mp3"))

    def test_preparation_never_uploads(self) -> None:
        self.invoke(apply=False)
        self.assertEqual(self.store.writes, 0)

    def test_changed_cloud_original_is_not_overwritten(self) -> None:
        self.store.data = b"external edit"
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertEqual(self.store.writes, 0)

    def test_upload_is_verified_and_idempotent(self) -> None:
        self.invoke()
        self.invoke()
        self.assertEqual(self.store.writes, 1)
        self.assertEqual(self.store.data, b"adjusted audio")
        self.assertEqual((self.directory / "original.mp3").read_bytes(), b"original audio")
        self.assertFalse((self.directory / "adjusted.mp3").exists())

    def test_uncertain_upload_is_verified_without_uploading_twice(self) -> None:
        self.store.fail_after_upload = True
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertEqual(self.store.writes, 1)
        self.store.fail_after_upload = False
        self.invoke()
        self.assertEqual(self.store.writes, 1)
        receipt = json.loads((self.directory / "receipt.json").read_text())
        self.assertEqual(receipt["state"], "applied")
        self.assertTrue(receipt["public_ranges_verified"])


if __name__ == "__main__":
    unittest.main()
