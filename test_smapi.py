#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
# ]
# ///

"""Smoke-test a deployed ReiTunes SMAPI browse and playback flow."""

from __future__ import annotations

import argparse
import re
import xml.etree.ElementTree as ET

import requests

SONOS_NAMESPACE = "http://www.sonos.com/Services/1.1"
NAMESPACES = {"sonos": SONOS_NAMESPACE}


def soap_envelope(content: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        f"<soap:Body>{content}</soap:Body>"
        "</soap:Envelope>"
    )


def post_smapi(base_url: str, action: str, content: str) -> ET.Element:
    response = requests.post(
        f"{base_url.rstrip('/')}/smapi/v1/soap",
        headers={
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": f'"{SONOS_NAMESPACE}#{action}"',
        },
        data=soap_envelope(content),
        timeout=30,
    )
    response.raise_for_status()
    return ET.fromstring(response.text)


def required_text(element: ET.Element, path: str) -> str:
    value = element.findtext(path, namespaces=NAMESPACES)
    if value is None:
        raise RuntimeError(f"SMAPI response did not contain {path}")
    return value


def test_service(base_url: str) -> None:
    root = post_smapi(
        base_url,
        "getMetadata",
        f'<getMetadata xmlns="{SONOS_NAMESPACE}">'
        "<id>root</id><index>0</index><count>100</count>"
        "</getMetadata>",
    )
    collection_ids = {
        text
        for element in root.findall(".//sonos:mediaCollection/sonos:id", NAMESPACES)
        if (text := element.text) is not None
    }
    expected_collections = {"tracks", "artists", "albums"}
    if not expected_collections.issubset(collection_ids):
        raise RuntimeError(
            f"Root browse returned {collection_ids}, expected {expected_collections}"
        )
    print(f"Root browse works: {', '.join(sorted(collection_ids))}")

    tracks = post_smapi(
        base_url,
        "getMetadata",
        f'<getMetadata xmlns="{SONOS_NAMESPACE}">'
        "<id>tracks</id><index>0</index><count>100</count>"
        "</getMetadata>",
    )
    total = int(required_text(tracks, ".//sonos:getMetadataResult/sonos:total"))
    track_id = required_text(tracks, ".//sonos:mediaMetadata/sonos:id")
    title = required_text(tracks, ".//sonos:mediaMetadata/sonos:title")
    print(f"Track browse works: {total} songs; first is {title!r}")

    for category in ("artists", "albums"):
        category_response = post_smapi(
            base_url,
            "getMetadata",
            f'<getMetadata xmlns="{SONOS_NAMESPACE}">'
            f"<id>{category}</id><index>0</index><count>100</count>"
            "</getMetadata>",
        )
        category_total = int(
            required_text(
                category_response, ".//sonos:getMetadataResult/sonos:total"
            )
        )
        child_id = required_text(
            category_response, ".//sonos:mediaCollection/sonos:id"
        )
        child_response = post_smapi(
            base_url,
            "getMetadata",
            f'<getMetadata xmlns="{SONOS_NAMESPACE}">'
            f"<id>{child_id}</id><index>0</index><count>1</count>"
            "</getMetadata>",
        )
        required_text(child_response, ".//sonos:mediaMetadata/sonos:id")
        print(f"{category.capitalize()} browse works: {category_total} entries")

    search_term = next(
        (word for word in re.findall(r"[A-Za-z0-9]+", title) if len(word) >= 3),
        title,
    )
    results = post_smapi(
        base_url,
        "search",
        f'<search xmlns="{SONOS_NAMESPACE}">'
        f"<id>all</id><term>{search_term}</term><index>0</index><count>100</count>"
        "</search>",
    )
    result_total = int(required_text(results, ".//sonos:searchResult/sonos:total"))
    if result_total == 0:
        raise RuntimeError(f"Search returned no results for {search_term!r}")
    print(f"Search works: {result_total} results for {search_term!r}")

    media = post_smapi(
        base_url,
        "getMediaURI",
        f'<getMediaURI xmlns="{SONOS_NAMESPACE}"><id>{track_id}</id></getMediaURI>',
    )
    media_uri = required_text(media, ".//sonos:getMediaURIResult")
    print(f"Playback URL works: {media_uri}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:5000")
    args = parser.parse_args()
    test_service(args.base_url)


if __name__ == "__main__":
    main()
