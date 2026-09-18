#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28", "jsonschema>=4.23", "python-dotenv>=1.0"]
# ///
"""Offline checks for the pilot's read-only tool boundaries."""
from pathlib import Path
import json
import tempfile
import unittest
import httpx
from jsonschema import ValidationError
from tagging_agent_eval import Research, MOONFACE, CASES, run_repeat
from tagging_agent_score import score
from tagging_musicbrainz import MusicBrainzCache

class AgentToolsTests(unittest.TestCase):
    def test_output_repair_is_counted_and_disables_further_tools(self):
        final = {"items": [{"id": case["id"], "tags": [], "uncertainty": "Unresolved", "research": {"artist_mbid": None, "recording_mbid": None, "reason": "Insufficient evidence"}} for case in CASES]}
        requests = []
        def handle(request):
            requests.append(json.loads(request.content))
            content = "Here are the tags. " + json.dumps(final) if len(requests) == 1 else json.dumps(final)
            return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": content}}], "usage": {"cost": 0.001}})
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(handle)) as client:
            root = Path(directory)
            cache = MusicBrainzCache(root / "cache.sqlite", client)
            metadata = [{"id": case["id"], "musicbrainz": {}} for case in CASES]
            result = run_repeat(client, cache, metadata, root, 1, "test-not-a-real-key")
            self.assertEqual(result["model_calls"], 2)
            self.assertEqual(len(result["validation_errors"]), 1)
            self.assertNotIn("tools", requests[1])
            self.assertNotIn("tool_choice", requests[1])
            self.assertEqual(result["cost_usd"], 0.002)
            self.assertEqual(cache.network_requests, 0)
            cache.db.close()

    def test_scorer_counts_false_matches_not_just_retrieval(self):
        cases = [{"id": "a", "expected_artist": MOONFACE}, {"id": "b", "expected_artist": None, "no_recording": True}]
        result = score(cases, {"a": {"artist_mbid": MOONFACE}, "b": {"artist_mbid": MOONFACE, "recording_mbid": "wrong"}})
        self.assertEqual(result["correct_artist_candidates"], 1)
        self.assertEqual(result["wrong_artist_candidates"], 1)
        self.assertEqual(result["recording_abstentions_on_traps"], 0)

    def test_lookup_requires_evidence_for_every_item_and_shares_cached_results(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, json={"artists": [{"id": MOONFACE, "name": "Moonface"}]})
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(handle)) as client:
            cache = MusicBrainzCache(Path(directory) / "cache.sqlite", client)
            research = Research(cache, [])
            with self.assertRaises(ValueError):
                research.execute("lookup_entity", {"item_ids": ["t01"], "entity_type": "artist", "mbid": MOONFACE})
            args = {"item_ids": ["t01", "t02"], "name": "Moonface"}
            research.execute("search_artists", args)
            research.execute("search_artists", args)
            self.assertEqual(len(requests), 1)
            self.assertIn(("artist", MOONFACE), research.seen["t02"])
            with self.assertRaises(ValueError):
                research.execute("lookup_entity", {"item_ids": ["t01", "t03"], "entity_type": "artist", "mbid": MOONFACE})
            with self.assertRaises(ValidationError):
                research.execute("search_artists", {"item_ids": ["invented"], "name": "Moonface"})
            cache.db.close()

    def test_qualifiers_are_preserved_and_budget_stops_network_access(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, json={"recordings": []})
        with tempfile.TemporaryDirectory() as directory, httpx.Client(transport=httpx.MockTransport(handle)) as client:
            cache = MusicBrainzCache(Path(directory) / "cache.sqlite", client)
            research = Research(cache, [])
            research.execute("search_recordings", {"item_ids": ["t05"], "title": "Song (Live)", "artist": "A+B", "album": ""})
            query = requests[0].url.params["query"]
            self.assertIn("live", query)
            self.assertIn(r"a\+b", query)
            research.calls = 16
            self.assertIn("error", research.execute("search_artists", {"item_ids": ["t01"], "name": "Another"}))
            self.assertEqual(len(requests), 1)
            cache.db.close()

if __name__ == "__main__":
    unittest.main()
