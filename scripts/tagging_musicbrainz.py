#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28"]
# ///
"""Cache read-only MusicBrainz evidence for the local tagging sample. No web search."""
import fcntl
import hashlib
import json
import re
import sqlite3
import time
import unicodedata
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parents[1] / "target/tagging"
API = "https://musicbrainz.org/ws/2/"
USER_AGENT = "ReiTunesTaggingLab/0.1 (https://github.com/rgwood/reitunes)"


class NetworkPaused(RuntimeError):
    """No request was attempted because the collector is backing off."""


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def quoted(value: str) -> str:
    # Escape Lucene operators as well as quotes; metadata cannot become query syntax.
    return '"' + re.sub(r'([+\-!(){}\[\]^"~*?:\\/|&])', r'\\\1', normalize(value)) + '"'


class MusicBrainzCache:
    def __init__(self, path: Path, client: httpx.Client) -> None:
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, fetched_at TEXT, payload TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS rate_limit (id INTEGER PRIMARY KEY, next_request REAL)")
        self.client = client
        self.network_requests = 0
        self.cache_hits = 0
        self.blocked = False
        self.diagnostics: list[dict] = []

    def get(self, kind: str, entity_id: str | None = None, query: str | None = None) -> dict:
        key = f"entity:{kind}:{entity_id}" if entity_id else f"search:{kind}:{query}"
        row = self.db.execute("SELECT payload FROM responses WHERE key=?", (key,)).fetchone()
        if row:
            self.cache_hits += 1
            return json.loads(row[0])
        params = {"fmt": "json"}
        if entity_id:
            params["inc"] = {"recording": "artist-credits+releases+tags+artist-rels+work-rels",
                             "artist": "aliases+tags", "release": "artist-credits+release-groups+labels"}[kind]
        else:
            params.update(query=query or "", limit="5")
        url = API + kind + ("/" + entity_id if entity_id else "")
        for attempt in range(3):
            response = self.request(url, params)
            if response.status_code not in (429, 503):
                break
            retry_after = response.headers.get("Retry-After", "0")
            try:
                delay = float(retry_after)
            except ValueError:
                try:
                    delay = parsedate_to_datetime(retry_after).timestamp() - time.time()
                except (ValueError, TypeError, OverflowError):
                    delay = 0
            delay = max(10 * 2 ** attempt, delay)
            self.blocked = attempt == 2 or delay > 60
            if self.blocked:
                delay = max(60, delay)
            self.db.execute("INSERT OR REPLACE INTO rate_limit VALUES(1, ?)", (time.time() + delay,))
            self.db.commit()
            print(json.dumps({"http_status": response.status_code, "attempt": attempt + 1,
                              "backoff_seconds": delay, "paused": self.blocked}), flush=True)
            if self.blocked:
                raise RuntimeError(f"MusicBrainz HTTP {response.status_code}; paused after {attempt + 1} attempt(s)")
        response.raise_for_status()
        data = response.json()
        self.db.execute("INSERT INTO responses VALUES(?,?,?)", (key, datetime.now(timezone.utc).isoformat(), json.dumps(data)))
        self.db.commit()
        return data

    def request(self, url: str, params: dict) -> httpx.Response:
        if self.blocked or self.network_requests >= 60:
            raise NetworkPaused("Network requests paused; cached evidence remains available")
        due = self.db.execute("SELECT next_request FROM rate_limit WHERE id=1").fetchone()
        if due:
            time.sleep(max(0, due[0] - time.time()))
        self.db.execute("INSERT OR REPLACE INTO rate_limit VALUES(1, ?)", (time.time() + 3,))
        self.db.commit()
        self.network_requests += 1
        response = self.client.get(url, params=params)
        self.diagnostics.append({"url": str(response.request.url), "status": response.status_code,
            "headers": {k: v for k, v in response.headers.items() if k in {
                "date", "retry-after", "server", "via", "x-cache-status", "x-mb-gateway",
                "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"}},
            "error_body": response.text[:2000] if response.is_error else None})
        return response


def artist_names(recording: dict) -> list[str]:
    return [credit.get("artist", {}).get("name", credit.get("name", ""))
            for credit in recording.get("artist-credit", []) if isinstance(credit, dict)]


def select_recording(candidates: list[dict], title: str, artist: str, album: str) -> dict | None:
    exact = [r for r in candidates if normalize(r.get("title", "")) == normalize(title)
             and normalize(artist) in {normalize(n) for n in artist_names(r)} and int(r.get("score", 0)) >= 95]
    if len(exact) > 1 and album:
        album_matches = [r for r in exact if any(normalize(release.get("title", "")) == normalize(album) for release in r.get("releases", []))]
        if len(album_matches) == 1:
            return album_matches[0]
    return exact[0] if len(exact) == 1 else None


def compact_artist(data: dict) -> dict:
    return {"mbid": data["id"], "name": data["name"], "disambiguation": data.get("disambiguation", ""),
            "type": data.get("type"), "aliases": [a["name"] for a in data.get("aliases", [])][:8],
            "community_tags": [t["name"] for t in sorted(data.get("tags", []), key=lambda t: -int(t.get("count", 0)))][:8],
            "source_url": "https://musicbrainz.org/artist/" + data["id"]}


def collect(item: dict, cache: MusicBrainzCache, partial: dict | None = None) -> dict:
    title, artist, album = item["name"], item["artist"], item["album"]
    result: dict = partial if partial is not None else {}
    result.update(recording_status="unresolved", sources=[], research_reasons=[], candidate_recordings=[])
    is_mix = bool(re.search(r"dj set|guest mix|essential mix|vinyl set|house mix", title, re.I))
    candidate = None
    if is_mix:
        result["recording_status"] = "dj-mix-not-resolved"
        result["research_reasons"].append("dj-mix-tracklist")
    elif artist and len(title) < 140 and title.isprintable():
        data = cache.get("recording", query=f"recording:{quoted(title)} AND artist:{quoted(artist)}")
        candidates = data.get("recordings", [])
        result["candidate_recordings"] = [{"mbid": r["id"], "title": r["title"], "artist": artist_names(r),
                                           "score": r.get("score"), "disambiguation": r.get("disambiguation", "")} for r in candidates[:3]]
        candidate = select_recording(candidates, title, artist, album)
        if not candidate:
            result["research_reasons"].append("ambiguous-recording" if candidates else "unknown-recording")
    else:
        result["research_reasons"].append("insufficient-metadata")
    artist_id = None
    if candidate:
        recording = cache.get("recording", entity_id=candidate["id"])
        result["recording_status"] = "exact-metadata-candidate"
        result["identity_caveat"] = "Unique title/artist match among returned results; local recording version has NOT been fingerprint-verified or human-confirmed."
        source_url = "https://musicbrainz.org/recording/" + recording["id"]
        result["recording"] = {"mbid": recording["id"], "title": recording["title"],
                               "length_ms": recording.get("length"), "first_release_date": recording.get("first-release-date"),
                               "artist_credits": artist_names(recording),
                               "community_tags": [t["name"] for t in recording.get("tags", [])][:8],
                               "relationships": [{"type": r["type"], "attributes": r.get("attributes", []),
                                                  "name": r.get("artist", r.get("work", {})).get("name", r.get("work", {}).get("title"))}
                                                 for r in recording.get("relations", [])][:12], "source_url": source_url}
        result["sources"].append(source_url)
        credits = [c for c in recording.get("artist-credit", []) if isinstance(c, dict) and normalize(c.get("artist", {}).get("name", "")) == normalize(artist)]
        if len(credits) == 1:
            artist_id = credits[0]["artist"]["id"]
        releases = [r for r in recording.get("releases", []) if album and normalize(r.get("title", "")) == normalize(album)]
        # Don't guess the user's exact release edition from an arbitrary first result.
        if len(releases) == 1:
            release = cache.get("release", entity_id=releases[0]["id"])
            url = "https://musicbrainz.org/release/" + release["id"]
            group = release.get("release-group", {})
            result["release_candidate"] = {"mbid": release["id"], "title": release["title"], "date": release.get("date"),
                                           "release_group": {k: group.get(k) for k in ("id", "title", "primary-type", "secondary-types", "first-release-date")},
                                           "source_url": url}
            result["sources"].append(url)
        elif releases:
            result["release_status"] = "multiple-editions-unresolved"
    if artist and not artist_id:
        artists = cache.get("artist", query=f"artist:{quoted(artist)}").get("artists", [])
        exact = [a for a in artists if normalize(a.get("name", "")) == normalize(artist) and int(a.get("score", 0)) >= 95]
        if len(exact) == 1:
            artist_id = exact[0]["id"]
        else:
            result["artist_status"] = "ambiguous-or-unknown"
    if artist_id:
        result["artist"] = compact_artist(cache.get("artist", entity_id=artist_id))
        result["sources"].append(result["artist"]["source_url"])
        result["artist_status"] = "name-matched-candidate"
    relationships = result.get("recording", {}).get("relationships", [])
    if not any(r["type"] == "vocal" for r in relationships):
        result["research_reasons"].append("vocal-status-unconfirmed")
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sample = json.loads((OUT / "sample.json").read_text())
    evidence: dict = {"schema_version": 1, "sample_id": sample["id"], "source": "MusicBrainz",
                      "created_at": datetime.now(timezone.utc).isoformat(), "items": {}}
    with (OUT / "musicbrainz.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another MusicBrainz collector is already running")
        with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=25) as client:
            cache = MusicBrainzCache(OUT / "musicbrainz-cache-v1.sqlite", client)
            try:
                for item in sample["items"]:
                    data: dict = {}
                    try:
                        collect(item, cache, data)
                    except NetworkPaused as error:
                        if not data.get("sources"):
                            data["recording_status"] = "deferred"
                        data["research_reasons"].append("lookup-deferred")
                        data["error"] = str(error)
                    except (httpx.HTTPError, RuntimeError) as error:
                        if not data.get("sources"):
                            data["recording_status"] = "lookup-error"
                        data["research_reasons"].append("lookup-error")
                        data["error"] = str(error)
                    evidence["items"][item["id"]] = data
                    print(json.dumps({"item": item["name"], "status": data["recording_status"]}), flush=True)
                evidence["statistics"] = {"network_requests": cache.network_requests, "cache_hits": cache.cache_hits,
                    "http_errors": sum(d["status"] >= 400 for d in cache.diagnostics),
                    "deferred_items": sum("lookup-deferred" in i["research_reasons"] for i in evidence["items"].values()),
                    "rate_limit_seconds": 3, "paid_search_requests": 0}
                evidence["request_diagnostics"] = cache.diagnostics
            finally:
                cache.db.close()
    encoded = json.dumps(evidence, indent=2)
    digest = hashlib.sha256(encoded.encode()).hexdigest()[:12]
    (OUT / f"musicbrainz-evidence-{digest}.json").write_text(encoded)
    (OUT / "musicbrainz-evidence.json").write_text(encoded)
    print(json.dumps(evidence["statistics"]), flush=True)


if __name__ == "__main__":
    main()
