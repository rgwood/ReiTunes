# Sonos Direct Control

This is the groundwork for choosing a Sonos speaker in the ReiTunes web UI and sending its queue there. It does not currently create a Sonos playback session or load anything onto a speaker.

## What works

- Sonos OAuth with one-time, 10-minute `state` values
- encrypted access and refresh token storage in SQLite
- automatic access token refresh
- read-only household, group, and player discovery
- authenticated Cloud Queue v2.3 `context`, `version`, `itemWindow`, and `timePlayed` endpoints
- creation of queue snapshots from ReiTunes library item IDs

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

With those settings present, open the Sonos panel in the ReiTunes toolbar and use `Connect Sonos`. Once the OAuth redirect completes, the panel should list the household's groups and players.

## Deliberately missing

The first request that could disturb a real speaker is creating a playback session; `loadCloudQueue` can then replace its queue and start playback. Neither call exists yet.

The remaining work is roughly:

1. Confirm that the ReiTunes Control integration is associated with the existing Sonos content integration.
2. Add an explicit user-triggered endpoint that creates or joins a playback session for the selected group.
3. Pass a prepared queue's base URL and bearer token to `loadCloudQueue`.
4. Subscribe to playback and session events so the web UI can stay in sync and report errors.
5. Decide how taking over a busy speaker should work before using `createSession`, which unconditionally replaces an existing session.

The initial queue implementation sends direct `mediaUrl` values, which the Cloud Queue API supports as an alternative to Sonos music object IDs. That may let the first prototype avoid account matching, but it needs testing with the real integration before relying on it.

Useful Sonos references:

- [Authorize](https://docs.sonos.com/docs/authorize)
- [Discover households and groups](https://docs.sonos.com/docs/discover)
- [Play audio with Cloud Queue](https://docs.sonos.com/docs/cloud-queue-play-audio)
- [Cloud Queue API](https://docs.sonos.com/reference/about-cloud-queue-api)
