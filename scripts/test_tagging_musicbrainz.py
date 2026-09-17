#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28"]
# ///
"""Offline tests: identity ambiguity, persistent cache, and rate-limit handling."""
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import httpx
from tagging_musicbrainz import MusicBrainzCache, NetworkPaused, quoted, select_recording


class MusicBrainzTests(unittest.TestCase):
    def test_ambiguous_recordings_are_not_silently_selected(self) -> None:
        a = {"id": "a", "title": "Song", "score": 100, "artist-credit": [{"artist": {"name": "Artist"}}], "releases": [{"title": "Album A"}]}
        b = {**a, "id": "b", "releases": [{"title": "Album B"}]}
        self.assertIsNone(select_recording([a, b], "Song", "Artist", ""))
        self.assertEqual(select_recording([a, b], "Song", "Artist", "Album B"), b)
        self.assertIsNone(select_recording([a], "Song (Live)", "Artist", ""))
        self.assertIsNone(select_recording([a], "Song", "Different Artist", ""))

    def test_persistent_entity_cache_reuses_same_mbid_across_runs(self) -> None:
        requests = []
        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"id": "same-artist", "name": "Artist"})
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(handler)) as client:
            path = Path(directory) / "cache.sqlite"
            first = MusicBrainzCache(path, client)
            self.assertEqual(first.get("artist", entity_id="same-artist")["name"], "Artist")
            first.db.close()
            second = MusicBrainzCache(path, client)
            second.get("artist", entity_id="same-artist")
            self.assertEqual(second.network_requests, 0)
            self.assertEqual(second.cache_hits, 1)
            second.db.close()
        self.assertEqual(len(requests), 1)

    @patch("tagging_musicbrainz.time.sleep")
    def test_rate_limit_does_not_cache_an_error_as_no_results(self, sleep) -> None:
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(503, headers={"Retry-After": "60"}))) as client:
            cache = MusicBrainzCache(Path(directory) / "cache.sqlite", client)
            with self.assertRaises(RuntimeError):
                cache.get("recording", query='recording:"song"')
            with self.assertRaises(NetworkPaused):
                cache.get("artist", query='artist:"name"')
            self.assertEqual(cache.network_requests, 3)
            self.assertEqual(cache.db.execute("SELECT count(*) FROM responses").fetchone()[0], 0)
            cache.db.close()

    @patch("tagging_musicbrainz.time.sleep")
    def test_transient_busy_response_recovers_and_caches_success(self, sleep) -> None:
        responses = iter([httpx.Response(503, headers={"Retry-After": "0"}, json={"error": "busy"}),
                          httpx.Response(200, json={"id": "artist", "name": "Artist"})])
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(lambda _: next(responses))) as client:
            cache = MusicBrainzCache(Path(directory) / "cache.sqlite", client)
            self.assertEqual(cache.get("artist", entity_id="artist")["name"], "Artist")
            self.assertEqual(cache.get("artist", entity_id="artist")["name"], "Artist")
            self.assertEqual(cache.network_requests, 2)
            self.assertEqual(cache.cache_hits, 1)
            self.assertFalse(cache.blocked)
            self.assertGreater(sleep.call_args.args[0], 9)
            self.assertEqual(cache.diagnostics[0]["error_body"], '{"error":"busy"}')
            cache.db.close()

    def test_lucene_operators_are_escaped(self) -> None:
        self.assertEqual(quoted('A+B "C"'), '"a\\+b \\"c\\""')


if __name__ == "__main__":
    unittest.main()
