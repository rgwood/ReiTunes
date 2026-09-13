This is a Rust + web UI port of ReiTunes. It can view+edit+play back audio using a local library database and audio files in cloud storage.

See [Sonos reliability tests](SONOS_TESTING.md) for the failure simulations, recovery rules and test commands.

## Motivation/background

I'm giving up on ReiTunes.Blazor; I'm not particularly enjoying working in .NET these days.

I want to be in Rust, and the easiest way to do that is with web UI. The web platform already has a ton of useful stuff like an <audio> player that can handle seeking etc. 

Someday it might be fun to explore something like Iced for the GUI but that will involve a lot of work. Would need to roll my own player widget and a lot of code for audio, files, network access etc.

## Future work

This is entirely single-node right now. I'm not sure whether to forge ahead with the original multi-node offline-first vision. It still appeals to me, but:

1. I'm not 100% offline very often
2. A web UI makes it especially tempting to just have a single central server
   1. If I'm already paying the complexity tax (HTTP requests, split brain thing) for web... maybe I should take advantage of that instead of treating this like a normal desktop app?

Still need to:
- implement better bookmark functionality (adding bookmarks, at least)

## Playback diagnostics

Production playback traces appear in the server journal with `[Playback]`. Run `just get-logs 100` from this directory. Each batch includes a page session ID, the frontend asset filename, ordered event timestamps, track IDs, command origins (including `ctrl-e`), and the audio element's state. An `oscillation` warning marks six play/pause changes within two seconds.

Traces exclude track titles, audio URLs and credentials. They batch up to 40 events every two seconds while active, report dropped events, and flush on page exit. Failed uploads time out without retries; this is diagnostic evidence, not a guaranteed audit log.

## Discovery

Open **Discover** in the library toolbar or collection menu. Follow a YouTube channel/playlist or SoundCloud profile/playlist, preview its entries, and choose a minimum duration. Listen opens the source in a new tab. Import uses the same downloader as the existing link-import dialog.

The first 10 matching entries go into the inbox. Other fetched entries stay in Archive. Sources refresh every 3 hours while ReiTunes is running; Refresh also checks them immediately. Each scan reads the first 50 source entries. This follows the source's ordering, so use a channel/profile for newest-first updates, or a playlist that puts new additions near the beginning. A source publishing more than 50 entries between checks can leave a gap; Browse archive can fetch additional batches.

Sources, entries, dismissals and import history persist in SQLite. History lets you restore dismissed sets. Unknown durations are looked up where possible and excluded when a minimum is set. Live and upcoming broadcasts are excluded.

### Downloader setup

Deploy the accompanying `~/source/Downloader` changes before using discovery. They add `POST /metadata` for metadata-only yt-dlp lookups, `POST /jobs` and `GET /jobs/{id}` for download progress, and include the original source URL in successful import callbacks. No additional yt-dlp installation is needed on the ReiTunes host.

ReiTunes derives the metadata endpoint from `DOWNLOADER_URL`: `http://potato-pi:3000/download` becomes `http://potato-pi:3000/metadata`. Set `DISCOVERY_METADATA_URL` to override it, at build time or runtime. The worker uses its existing yt-dlp executable; its optional `DISCOVERY_YTDLP` setting overrides that path for metadata lookups. Metadata requests are restricted to YouTube and SoundCloud, have time/output limits, and run at most 2 processes concurrently.

Completed imports are matched to library items by their source URL; older imports can also be recognized by yt-dlp's default `[id]` filename. Imported files remain in the library when you unfollow a source.

### Download progress

Import music → Link shows recent downloads. Discover → History shows the job attached to each imported set. The UI follows queued, downloading, converting, uploading, adding to the library, completed and failed stages. The percentage describes the current file transfer, so it can reset for another file; conversion and upload have no percentage. Audio is only marked complete after the worker's library callback succeeds. Video downloads do not claim to have added music to the library.

ReiTunes submits to the worker's `/jobs` endpoint and returns its job object from `POST /api/download`. The authenticated `GET /api/downloads/{id}` endpoint proxies status with caching disabled. Visible progress polls every 2 seconds, backs off after temporary errors, and stops on completion or failure. A failed status request never submits a download. Failed jobs offer an explicit retry; discovery checks the old job and prevents concurrent retries from queuing duplicate work.

Discovery job IDs persist in SQLite. Recent jobs also persist in this browser, including up to 20 finished jobs, so closing the dialog or reloading does not lose them. Open the Link tab or History to resume checking progress.

In Discovery → History, older entries without saved progress offer **Resend to downloader** and **Return to inbox**. Failed jobs and jobs the worker no longer knows about also offer retry and return controls. Returning a set clears its old job reference and makes it importable from the inbox without submitting anything. Resending gets a job ID so progress can be tracked. Active or completed jobs cannot be reset, and a temporary status outage does not permit a resend. Recovery and import requests for the same set are serialized to prevent simultaneous clicks from submitting duplicate work.

Run `cargo test -p reitunes downloads` and `cargo test -p reitunes discovery::tests::job_ids` for the worker contract and persisted retry checks. From `reitunes-web`, run `npm run test:e2e -- e2e/downloads.spec.ts e2e/discovery.spec.ts --retries=0` for the UI scenarios. These tests use fake workers and do not download media.
