#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Read a production event snapshot over SSH; never open its database for writing."""
import json
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "target/tagging"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    remote = """import sqlite3,json
c=sqlite3.connect('file:/home/reilly/bin/reitunes-library.db?mode=ro',uri=True)
c.execute('PRAGMA query_only=ON')
print(json.dumps(c.execute("SELECT AggregateId,CreatedTimeUtc,Serialized FROM events WHERE AggregateType='LibraryItem' ORDER BY CreatedTimeUtc").fetchall()))
"""
    result = subprocess.run(
        ["ssh", "-F", str(Path.home() / ".ssh/config"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "spudnik", "python3 -"],
        input=remote, text=True, capture_output=True, check=True, timeout=40,
    )
    items: dict[str, dict] = {}
    for item_id, created, serialized in json.loads(result.stdout):
        event = json.loads(serialized)
        kind = event["$type"].removeprefix("LibraryItem").removesuffix("Event")
        if kind == "Created":
            items[item_id] = dict(id=item_id, name=event["Name"], artist=event.get("Artist") or "",
                                  album=event.get("Album") or "", file_path=event["FilePath"],
                                  created_time_utc=created, is_favorite=False, play_count=0)
        elif kind == "Deleted":
            items.pop(item_id, None)
        elif item_id in items:
            item = items[item_id]
            if kind in ("NameChanged", "ArtistChanged", "AlbumChanged", "FilePathChanged"):
                field = {"NameChanged": "name", "ArtistChanged": "artist", "AlbumChanged": "album", "FilePathChanged": "file_path"}[kind]
                item[field] = event["New" + kind.removesuffix("Changed")]
            elif kind == "Played":
                item["play_count"] += 1
            elif kind in ("Favorited", "Unfavorited"):
                item["is_favorite"] = kind == "Favorited"
    (OUT / "library-metadata.json").write_text(json.dumps(list(items.values()), indent=2))
    print(f"Read {len(items)} items; {sum(i['is_favorite'] for i in items.values())} favourites. Snapshot saved locally.")
    for item in sorted(items.values(), key=lambda i: (i["is_favorite"], i["play_count"]), reverse=True)[:24]:
        print(json.dumps({k: item[k] for k in ("id", "name", "artist", "is_favorite", "play_count")}))
    print("RECENT")
    for item in sorted(items.values(), key=lambda i: i["created_time_utc"], reverse=True)[:16]:
        print(json.dumps({k: item[k] for k in ("id", "name", "artist", "created_time_utc")}))


if __name__ == "__main__":
    main()
