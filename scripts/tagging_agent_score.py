#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Score fixed artist expectations and abstention traps, not tag accuracy."""
import argparse
import json
from pathlib import Path

def score(cases: list[dict], identities: dict[str, dict]) -> dict:
    positive = [case for case in cases if case["expected_artist"]]
    negatives = [case for case in cases if not case["expected_artist"]]
    traps = [case for case in cases if case.get("no_recording")]
    return {
        "correct_artist_candidates": sum(identities[c["id"]].get("artist_mbid") == c["expected_artist"] for c in positive),
        "expected_artist_candidates": len(positive),
        "wrong_artist_candidates": sum(bool(identities[c["id"]].get("artist_mbid")) and identities[c["id"]]["artist_mbid"] != c["expected_artist"] for c in cases),
        "artist_abstentions_on_negatives": sum(not identities[c["id"]].get("artist_mbid") for c in negatives),
        "negative_cases": len(negatives),
        "recording_abstentions_on_traps": sum(not identities[c["id"]].get("recording_mbid") for c in traps),
        "recording_traps": len(traps),
        "recording_candidates": sum(bool(i.get("recording_mbid")) for i in identities.values()),
    }

def main() -> None:
    raise SystemExit("RETIRED: use cargo run -p tagging-engine --bin tagging-eval -- live (or replay). See tagging-engine/README.md. This Python code is an archived pilot, not production.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    cases = json.loads((args.directory / "cases.json").read_text())
    baseline = json.loads((args.directory / "baseline.json").read_text())
    identities = {item["id"]: {kind + "_mbid": item["musicbrainz"].get(kind, {}).get("mbid") for kind in ("artist", "recording")} for item in baseline["items"]}
    report = {"baseline": {**score(cases, identities), "network_requests": baseline["network_requests"], "cache_hits": baseline["cache_hits"]}, "runs": []}
    for directory in sorted(args.directory.glob("repeat-*")):
        known = {item["id"]: {item["musicbrainz"].get("artist", {}).get("mbid")} - {None} for item in baseline["items"]}
        tool_errors = []
        for path in sorted(directory.glob("*-tool-*.json")):
            entry = json.loads(path.read_text())
            if "error" in entry["result"]:
                tool_errors.append(entry["result"]["error"].splitlines()[0])
                continue
            call = entry["call"]["function"]
            arguments = json.loads(call["arguments"])
            for candidate in entry["result"].get("candidates", []):
                artists = {credit["id"] for credit in candidate.get("artist_credits", []) if isinstance(credit, dict) and credit.get("id")}
                if call["name"] == "search_artists" or arguments.get("entity_type") == "artist":
                    artists.add(candidate["mbid"])
                for item_id in arguments["item_ids"]:
                    known[item_id].update(artists)
        accounting = json.loads((directory / "accounting.json").read_text())
        costs = accounting["costs"]
        run = {"repeat": directory.name, "accepted": (directory / "result.json").exists(), "retrieved_expected_artists": sum(c["expected_artist"] in known[c["id"]] for c in cases if c["expected_artist"]), "tool_errors": tool_errors, "cost_usd": sum(costs) if all(c is not None for c in costs) else None, "successful_model_calls": len(costs), "model_seconds": sum(accounting["model_seconds"])}
        if run["accepted"]:
            result = json.loads((directory / "result.json").read_text())
            identities = {i["id"]: i["research"] for i in result["predictions"]["items"]}
            run.update(output_repairs=len(result.get("validation_errors", [])), **score(cases, identities), **{k: result[k] for k in ("elapsed_seconds", "tool_calls", "network_requests", "cache_hits")})
        elif (directory / "failure.json").exists():
            run["failure"] = json.loads((directory / "failure.json").read_text())["error"]
        if not run["accepted"]:
            # Diagnostic scoring never turns a rejected response into an accepted result.
            for path in reversed(sorted(directory.glob("*-response.json"))):
                raw = json.loads(path.read_text())
                choices = raw.get("choices", [])
                if not choices or choices[0].get("finish_reason") != "stop":
                    continue
                content = choices[0]["message"].get("content") or ""
                try:
                    data, _ = json.JSONDecoder().raw_decode(content[content.index("{"):])
                    identities = {i["id"]: i["research"] for i in data["items"]}
                    run["rejected_output_diagnostic_only"] = score(cases, identities)
                except (ValueError, KeyError, TypeError):
                    pass
                break
        report["runs"].append(run)
    diagnostics_path = args.directory / "diagnostics.json"
    if diagnostics_path.exists():
        diagnostics = json.loads(diagnostics_path.read_text())
        report["http_statuses"] = {str(status): sum(d["status"] == status for d in diagnostics) for status in sorted({d["status"] for d in diagnostics})}
    (args.directory / "score.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
