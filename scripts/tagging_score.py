#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Score saved predictions against exported human labels, with no API calls."""
import argparse
import json
from itertools import combinations
from pathlib import Path


def normalize(tag: str) -> str:
    return "-".join(tag.strip().lower().split())


def summarize(experiment: dict, review: dict) -> dict:
    results = []
    for run in experiment["runs"]:
        counts = dict(accepted=0, rejected=0, uncertain=0, pending=0)
        missing = []
        for prediction in run["predictions"]:
            labels = review.get("items", {}).get(prediction["id"], {}).get("labels", {})
            predicted = {normalize(t["tag"]) for t in prediction["tags"]}
            for tag in predicted:
                verdict = labels.get(tag, {}).get("verdict", "pending")
                if verdict not in counts:
                    raise ValueError("Invalid human verdict")
                counts[verdict] += 1
            missing.extend({"item_id": prediction["id"], "tag": t} for t, label in labels.items()
                           if label["verdict"] == "accepted" and t not in predicted)
        judged = counts["accepted"] + counts["rejected"]
        results.append(dict(run_id=run["id"], model=run["model"], **counts,
                            precision=counts["accepted"] / judged if judged else None,
                            human_accepted_tags_missing=missing, latency_seconds=run["latency_seconds"],
                            cost_usd=run.get("cost_usd")))
    agreement = []
    for a, b in combinations(experiment["runs"], 2):
        left = {p["id"]: {normalize(t["tag"]) for t in p["tags"]} for p in a["predictions"]}
        right = {p["id"]: {normalize(t["tag"]) for t in p["tags"]} for p in b["predictions"]}
        values = []
        for item_id in left.keys() & right.keys():
            union = left[item_id] | right[item_id]
            values.append({"item_id": item_id, "jaccard": len(left[item_id] & right[item_id]) / len(union) if union else 1.0})
        agreement.append(dict(run_a=a["id"], run_b=b["id"], same_model=a["model"] == b["model"],
                              mean_jaccard=sum(v["jaccard"] for v in values) / len(values) if values else None,
                              items=sorted(values, key=lambda v: v["item_id"])))
    return dict(schema_version=1, experiment_id=experiment["id"], scores=results, agreement=agreement,
                note="Exact normalized tags only, no synonym matching. Precision excludes pending and uncertain. Agreement is not correctness. Missing accepted tags are omissions against partial labels, not exhaustive recall.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", type=Path)
    parser.add_argument("--review", type=Path, help="Export from the review UI; can come from an older experiment")
    args = parser.parse_args()
    data = json.loads(args.experiment.read_text())
    experiment = data.get("experiment", data)
    review = json.loads(args.review.read_text()) if args.review else data.get("human_review", {})
    review = review.get("human_review", review)
    print(json.dumps(summarize(experiment, review), indent=2))


if __name__ == "__main__":
    main()
