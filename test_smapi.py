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
    collection_id = required_text(root, ".//sonos:mediaCollection/sonos:id")
    print(f"Root browse works: {collection_id}")

    tracks = post_smapi(
        base_url,
        "getMetadata",
        f'<getMetadata xmlns="{SONOS_NAMESPACE}">'
        f"<id>{collection_id}</id><index>0</index><count>100</count>"
        "</getMetadata>",
    )
    total = int(required_text(tracks, ".//sonos:getMetadataResult/sonos:total"))
    track_id = required_text(tracks, ".//sonos:mediaMetadata/sonos:id")
    title = required_text(tracks, ".//sonos:mediaMetadata/sonos:title")
    print(f"Track browse works: {total} songs; first is {title!r}")

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
