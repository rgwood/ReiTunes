# Sonos Direct Control

ReiTunes can use either the current browser or a Sonos speaker group as its playback output. Browser playback remains the default. Choosing a Sonos group does not start anything by itself; the next explicit play action creates a playback session and sends the current ReiTunes queue to that group.

## What works

- Sonos OAuth with one-time, 10-minute `state` values
- encrypted access and refresh token storage in SQLite
- automatic access token refresh
- household, group, and player discovery
- authenticated Cloud Queue v2.3 `context`, `version`, `itemWindow`, and `timePlayed` endpoints
- creation of queue snapshots from ReiTunes library item IDs
- explicit `createSession` takeover followed by `loadCloudQueue`
- bookmark playback positions, passed to Sonos as `positionMillis`
- reuse of ReiTunes's existing playback session for later song choices
- a persisted browser/Sonos output selector in the web UI

The Cloud Queue snapshots use a separate random bearer token. The public endpoints do not accept the ReiTunes session cookie and do not reveal queue metadata without that token.

## Configuration

Create a Control integration in the [Sonos integration manager](https://integration.sonos.com/) and add this exact redirect URL to it:

```text
https://<reitunes-host>/api/sonos/callback
```

Then configure:

```text
SONOS_CLIENT_ID=...
SONOS_CLIENT_SECRET=...
SONOS_REDIRECT_URI=https://<reitunes-host>/api/sonos/callback
SONOS_TOKEN_ENCRYPTION_SECRET=<a unique random value of at least 32 characters>
```

`REITUNES_HOSTNAME` and `URL_SCHEME` also need to describe the public ReiTunes address. Sonos speakers only call Cloud Queue servers over HTTPS.

With those settings present, open the Sonos panel in the ReiTunes toolbar and use `Connect Sonos`. Once the OAuth redirect completes, the panel lists the household's groups and players. Choose a group, close the panel, and select a song. Use `This browser` in the same panel to route later play actions back to the browser.

## Playback safety

Sonos's `createSession` command unconditionally replaces any existing session. ReiTunes therefore refuses to create one unless the web UI has recorded an explicit group selection. It caches the resulting session and reuses it for later queues.

If Sonos rejects a cached session—for example, because another app took over—ReiTunes forgets it and requires another confirmation. It never automatically creates a replacement session and fights the other controller.

Switching back to browser output only changes where future ReiTunes play actions go. It does not stop whatever Sonos is already doing.

## Still missing

The first playback version deliberately leaves Sonos transport controls in the Sonos app. The next useful work is:

1. Subscribe to playback, playback metadata, and session events.
2. Reflect the actual Sonos play/pause state and playhead in ReiTunes.
3. Add remote pause, skip, seek, and volume controls once that state stays in sync.
4. Refresh an active Cloud Queue when the ReiTunes queue changes.

The queue sends direct `mediaUrl` values, which the Cloud Queue API supports as an alternative to Sonos music object IDs. The media URLs do not use the Cloud Queue bearer token; that token only protects the queue metadata endpoints.

Useful Sonos references:

- [Authorize](https://docs.sonos.com/docs/authorize)
- [Discover households and groups](https://docs.sonos.com/docs/discover)
- [Play audio with Cloud Queue](https://docs.sonos.com/docs/cloud-queue-play-audio)
- [Cloud Queue API](https://docs.sonos.com/reference/about-cloud-queue-api)
