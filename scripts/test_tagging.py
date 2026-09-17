#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28", "jsonschema>=4.23", "python-dotenv>=1.0"]
# ///
"""Offline contract tests for the experiment harness and scoring export."""
import unittest
import json
from pathlib import Path
from copy import deepcopy
from tagging_experiment import build_request, check_predictions, parse_predictions
from tagging_score import summarize


class TaggingTests(unittest.TestCase):
    def test_production_contract_reproduces_evaluated_twenty_item_request(self) -> None:
        fixture = json.loads((Path(__file__).resolve().parents[1] / "reitunes/test-fixtures/tagging-evaluated.json").read_text())
        expected = fixture["request"]
        metadata = json.loads(expected["messages"][1]["content"])
        self.assertEqual(build_request("z-ai/glm-5.3-flash", {}, metadata, "high", database=True), expected)

    def test_json_wrapper_tolerance_cannot_hide_prose_or_second_object(self) -> None:
        data, note = parse_predictions(' {"items": []}\n``')
        self.assertEqual(data, {"items": []})
        self.assertIsNotNone(note)
        for content in ('{"items": []} invented prose', '{"items": []} {"items": []}'):
            with self.assertRaises(ValueError):
                parse_predictions(content)

    def test_glm_is_pinned_to_official_zai_without_fallbacks(self) -> None:
        spec = {"pricing": {"prompt": "0.00000009", "completion": "0.0000003"},
                "supported_parameters": ["structured_outputs"]}
        request = build_request("z-ai/glm-5.3-flash", spec, [])
        self.assertEqual(request["provider"]["only"], ["z-ai"])
        self.assertFalse(request["provider"]["allow_fallbacks"])
        self.assertEqual(request["response_format"], {"type": "json_object"})
        self.assertIn('Return JSON matching this schema', request["messages"][0]["content"])

    def test_database_evidence_uses_no_search_tools(self) -> None:
        spec = {"pricing": {"prompt": "0.0000002", "completion": "0.0000012"},
                "supported_parameters": ["reasoning", "structured_outputs"], "reasoning": {"supported_efforts": ["high"]}}
        request = build_request("test/model", spec, [{"id": "t01", "musicbrainz": {"sources": []}}], "high", database=True)
        self.assertNotIn("tools", request)
        self.assertEqual(request["reasoning"], {"effort": "high"})
        schema = request["response_format"]["json_schema"]["schema"]
        data = {"items": [{"id": "t01", "uncertainty": "Candidate only", "tags": [
            {"tag": "folk", "basis": "database", "confidence": 0.5, "evidence": "Artist tag", "source_urls": []}]}]}
        check_predictions(data, {"t01"}, schema)

    def test_reasoning_models_omit_unsupported_temperature_and_cap_provider_prices(self) -> None:
        spec = {"pricing": {"prompt": "0.0000002", "completion": "0.0000012"},
                "supported_parameters": ["reasoning", "structured_outputs"], "reasoning": {"supported_efforts": ["low", "high"]}}
        request = build_request("test/luna", spec, [])
        self.assertNotIn("temperature", request)
        self.assertEqual(request["reasoning"], {"effort": "low"})
        self.assertEqual(request["provider"]["max_price"], {"prompt": 0.2, "completion": 1.2, "request": 0})
        self.assertEqual(request["max_tokens"], 8000)

    def test_missing_and_duplicate_ids_are_rejected(self) -> None:
        item = {"id": "a", "uncertainty": "Unknown", "tags": []}
        for data in ({"items": []}, {"items": [item, item]}, {"items": [{**item, "id": "invented"}]}):
            with self.assertRaises(ValueError):
                check_predictions(data, {"a"})

    def test_web_search_limits_schema_and_high_reasoning(self) -> None:
        spec = {"pricing": {"prompt": "0.0000002", "completion": "0.0000012"},
                "supported_parameters": ["reasoning", "structured_outputs"], "reasoning": {"supported_efforts": ["low", "high"]}}
        request = build_request("test/model", spec, [{"id": "a"}], "high", True)
        self.assertEqual(request["reasoning"]["effort"], "high")
        self.assertEqual(request["max_tool_calls"], 3)
        self.assertEqual(request["tools"][0]["parameters"]["max_uses"], 3)
        schema = request["response_format"]["json_schema"]["schema"]
        from jsonschema import ValidationError
        with self.assertRaises(ValidationError):
            check_predictions({"items": [{"id": "invented", "tags": [], "uncertainty": ""}]}, {"a"}, schema)

    def test_unheard_audio_cannot_be_claimed_as_evidence_basis(self) -> None:
        data = {"items": [{"id": "a", "uncertainty": "", "tags": [{"tag": "house", "basis": "audio", "confidence": 0.8, "evidence": "I heard it"}]}]}
        from jsonschema import ValidationError
        with self.assertRaises(ValidationError):
            check_predictions(data, {"a"})

    def test_valid_abstention_and_normalization(self) -> None:
        data = {"items": [{"id": "a", "uncertainty": "Cannot identify", "tags": []}]}
        check_predictions(data, {"a"})
        tag = {"tag": " HIGH Energy ", "basis": "inference", "confidence": 0.5, "evidence": "Uncertain guess"}
        tagged = {"items": [{"id": "a", "uncertainty": "Listen first", "tags": [tag]}]}
        check_predictions(tagged, {"a"})
        self.assertEqual(tag["tag"], "high-energy")

    def test_partial_labels_and_repeat_agreement(self) -> None:
        run: dict = dict(id="run-a", model="test", latency_seconds=2, cost_usd=0.01,
                   predictions=[dict(id="a", tags=[dict(tag="house"), dict(tag="instrumental")])])
        second = deepcopy(run)
        second["id"] = "run-b"
        second["predictions"][0]["tags"] = [dict(tag="house"), dict(tag="low energy")]
        experiment = dict(id="sample", runs=[run, second])
        review = dict(items={"a": {"labels": {"house": {"verdict": "accepted"}, "instrumental": {"verdict": "uncertain"}, "vocal": {"verdict": "accepted"}}}})
        result = summarize(experiment, review)
        self.assertEqual(result["scores"][0]["precision"], 1)
        self.assertEqual(result["scores"][0]["uncertain"], 1)
        self.assertEqual(result["scores"][1]["pending"], 1)
        self.assertEqual(result["scores"][0]["human_accepted_tags_missing"], [dict(item_id="a", tag="vocal")])
        self.assertAlmostEqual(result["agreement"][0]["mean_jaccard"], 1 / 3)
        self.assertIsNone(summarize(experiment, {})["scores"][0]["precision"])


if __name__ == "__main__":
    unittest.main()
