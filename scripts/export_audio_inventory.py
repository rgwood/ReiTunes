#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Read the live library's current file paths and durations without changing it."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--host", default="spudnik")
    parser.add_argument("--database", default="/home/reilly/bin/reitunes-library.db")
    parser.add_argument("--ssh-config", type=Path, default=Path.home() / ".ssh/config")
    args = parser.parse_args()
    sql = """SELECT AggregateId, Serialized FROM events
    WHERE AggregateType = 'LibraryItem' AND json_extract(Serialized, '$.$type') IN
    ('LibraryItemCreatedEvent', 'LibraryItemDeletedEvent', 'LibraryItemNameChangedEvent',
     'LibraryItemFilePathChangedEvent', 'LibraryItemDurationChangedEvent')
    ORDER BY CreatedTimeUtc, rowid"""
    command = shlex.join(["sqlite3", "-json", "-readonly", args.database, sql])
    result = subprocess.run(["ssh", "-F", str(args.ssh_config), "-o", "BatchMode=yes", args.host, command],
                            check=True, capture_output=True, text=True, timeout=120)
    items: dict[str, dict[str, Any]] = {}
    for row in json.loads(result.stdout):
        key = row["AggregateId"]
        event = json.loads(row["Serialized"])
        kind = event["$type"]
        if kind == "LibraryItemCreatedEvent":
            items[key] = {**event, "Id": key}
        elif kind == "LibraryItemDeletedEvent":
            items.pop(key, None)
        elif key in items:
            if kind == "LibraryItemNameChangedEvent":
                items[key]["Name"] = event["NewName"]
            elif kind == "LibraryItemFilePathChangedEvent":
                items[key]["FilePath"] = event["NewFilePath"]
                items[key].pop("Seconds", None)
            elif kind == "LibraryItemDurationChangedEvent":
                items[key]["Seconds"] = event["Seconds"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(list(items.values()), indent=2) + "\n")
    print(f"Exported {len(items)} library items to {args.output}")


if __name__ == "__main__":
    main()
