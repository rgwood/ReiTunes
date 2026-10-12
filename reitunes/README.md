This is a Rust + web UI port of ReiTunes. It can view+edit+play back audio using a local library database and audio files in cloud storage.

See [Sonos direct control](SONOS_DIRECT_CONTROL.md) for setup and design notes, and [Sonos reliability tests](SONOS_TESTING.md) for the failure simulations, recovery rules and test commands.

## Mobile

On a phone, ReiTunes opens with Playing, Queue and Browse tabs. Playing controls the current output; Browse has songs, playlists, Discover and bookmarks. A song's ••• menu has queue, playlist, metadata and tracklist actions. Queue has up/down buttons for touch reordering. The desktop grid remains available above 700px.

Open ReiTunes in iPhone Safari, then use Share → Add to Home Screen for a standalone window. Streaming needs a network connection; installation does not download the library. Use the output selector on Playing to control Sonos or choose Listen on this device. If Safari requires another gesture after a transfer, tap Play. Device volume buttons control phone/headphone playback; the on-screen slider controls Sonos.

There is one shared playback session for the household. Opening another screen attaches to its output and queue without starting music. The server persists the queue and retries Sonos queue updates even after the browser closes. A waking screen refreshes before accepting edits; concurrent conflicting edits show a message instead of silently replacing the newer queue. Browser audio belongs to the page that explicitly started it; other pages can view the session and choose to move playback. A page reload stays paused.

For the first upgrade from browser-local queues, refresh the existing desktop tab before opening a new phone window. That tab migrates its output and queue into the shared session once.

## Smart Playlists and tags

Create a Smart Playlist from the sidebar’s playlist menu. Choose **all (AND)** or **any (OR)** and add rules or nested groups. Rules cover tags, duration, artist, album, title, play count, date added, favourites and bookmarks. For example: duration under 10 minutes AND (tag includes folk OR tag includes indie-rock). Tag rules can include or exclude an exact tag, with suggestions from the library; **Has tags: No** finds tracks with no current tags. Matches use the same automatic and manually edited tags shown in the library, and update when tags change. The editor previews the matching tracks and their total duration. Existing playlists keep their original rules when edited.

Duration appears as a sortable library column. Uploads read it from the audio file, downloads can use source metadata, and playback saves the measured length. Duration comparisons exclude unknown lengths; use the **Duration known** rule to find recordings that still need a measurement.

Shuffle uses a saved order without repeating tracks until that order is exhausted. The browser player, Sonos and Up Next use the same order. Changing shuffle on Sonos updates the upcoming queue without restarting the current song.

Open **Tags** in the sidebar to browse tags, or right-click a song and choose **Edit tags…** to add or remove them. Clicking a tag searches the library; you can also type `tag:house` in search. Manual edits and saved suggestions work without an AI provider. Automatic suggestions require `OPENROUTER_API_KEY` at build time or runtime, and use song metadata rather than listening to the audio.

Import name/artist detection also uses OpenRouter, with `openai/gpt-6-luna`. If metadata detection is unavailable, imports keep the known Discover title or a cleaned filename. The downloader still completes the import.

The production publish command requires the OpenRouter key for import metadata and automatic tag suggestions. It accepts `OPENROUTER_API_KEY`, a file named by `OPENROUTER_API_KEY_FILE`, or `openrouterkey.txt` in the repository root. A direct OpenAI API key is not needed.

## Deleting audio

Deleting a song also permanently removes its audio from object storage, unless another song still uses the same file. The server checks deletion history on startup and every 30 seconds, including songs deleted before storage cleanup was added.

The event log stays intact. A `storage_deletions` receipt is saved after each successful object deletion, so storage failures and interrupted requests are retried after a restart. Cleanup only deletes exact paths from deleted songs within the configured bucket and prefix; it does not scan for unrelated objects. Bucket versioning must be disabled: a versioned bucket needs a separate purge of retained versions to actually free storage, so cleanup refuses to mark those deletions complete.

## Playback diagnostics

Production playback traces appear in the server journal with `[Playback]`. Run `just get-logs 100` from this directory. Each batch includes a page session ID, the frontend asset filename, ordered event timestamps, track IDs, command origins (including `ctrl-e`), and the audio element's state. An `oscillation` warning marks six play/pause changes within two seconds.

Traces exclude track titles, audio URLs and credentials. They batch up to 40 events every two seconds while active, report dropped events, and flush on page exit. Failed uploads time out without retries; this is diagnostic evidence, not a guaranteed audit log.

## Discovery

Open **Discover →** in the compact library toolbar. Use **← Back to library** beside the search field to return to your music; your library search, collection filter and playlist are preserved. Follow a YouTube channel/playlist, SoundCloud profile/playlist or NTS show, preview its entries, and choose a minimum duration. Listen opens the source in a new tab. Import uses the same downloader as the existing link-import dialog.

Discovery uses compact rows with full descriptions visible and included in search. Save builds a shortlist without downloading. Saved sets and import history remain accessible after unfollowing their source. Browse by duration, sort by release date or length, or shuffle the current results. Source labels jump to that source's sets. All sets includes the older batches previously called Archive. Dismiss has an Undo action, and active imports stay visible above the results so they do not disappear when removed from the inbox.

The first 10 matching entries go into the inbox. Other fetched entries remain in All sets. Sources refresh every 3 hours while ReiTunes is running; Refresh also checks them immediately. Each scan reads the first 50 source entries. This follows the source's ordering, so use a channel/profile for newest-first updates, or a playlist that puts new additions near the beginning. A source publishing more than 50 entries between checks can leave a gap; select the source in All sets to fetch additional batches.

Sources, entries, dismissals and import history persist in SQLite. History lets you restore dismissed sets. Unknown durations are looked up where possible and excluded when a minimum is set. Live and upcoming broadcasts are excluded.

### NTS

Paste an NTS show or episode URL to follow its show. ReiTunes reads the public archive directly, including genres, descriptions and the public artist/title tracklist. Tracklists load when opened. NTS pages contain up to 12 episodes per API request, so ReiTunes combines bounded requests into the usual 50-entry batches.

An episode can be imported when NTS advertises a public SoundCloud recording. The NTS episode stays the listening link; the original SoundCloud URL goes to Downloader, and the finished library item is matched back to the NTS episode. Mixcloud-only or missing recordings stay available for external listening and saving, with import disabled. This uses neither embedded players nor supporter-only features.

NTS does not supply durations. ReiTunes gets them from Downloader metadata with at most 2 requests at once and reuses them on refresh. With no minimum duration, it resolves the first 10 entries; with a duration filter, it checks all candidates. NTS's public website API is undocumented and may change; failures appear on the source and can be retried. The native adapter and callback matching have local fixture tests; `cargo test -p reitunes discovery::nts::tests::real_archive -- --ignored` is an optional metadata-only check against the live archive.

### Downloader setup

Deploy the accompanying `~/source/Downloader` changes before using discovery. They add `POST /metadata` for metadata-only yt-dlp lookups, `POST /jobs` and `GET /jobs/{id}` for download progress, and include the original source URL in successful import callbacks. No additional yt-dlp installation is needed on the ReiTunes host.

ReiTunes derives the metadata endpoint from `DOWNLOADER_URL`: `http://potato-pi:3000/download` becomes `http://potato-pi:3000/metadata`. Set `DISCOVERY_METADATA_URL` to override it, at build time or runtime. The worker uses its existing yt-dlp executable; its optional `DISCOVERY_YTDLP` setting overrides that path for metadata lookups. Worker metadata requests are restricted to YouTube and SoundCloud, have time/output limits, and run at most 2 processes concurrently. SoundCloud playlists may supply numeric API references instead of public links; the worker accepts these only for individual metadata lookups, and ReiTunes stores the resolved public link. NTS catalogue requests come from ReiTunes; its linked SoundCloud recordings use the existing worker.

Completed imports are matched to library items by their source URL; older imports can also be recognized by yt-dlp's default `[id]` filename. Imported files remain in the library when you unfollow a source.

### Download progress

Import music → Link shows recent downloads. Discover → History shows the job attached to each imported set. The UI follows queued, downloading, converting, uploading, adding to the library, completed and failed stages. The percentage describes the current file transfer, so it can reset for another file; conversion and upload have no percentage. Audio is only marked complete after the worker's library callback succeeds. Video downloads do not claim to have added music to the library.

ReiTunes submits to the worker's `/jobs` endpoint and returns its job object from `POST /api/download`. The authenticated `GET /api/downloads/{id}` endpoint proxies status with caching disabled. Visible progress polls every 2 seconds, backs off after temporary errors, and stops on completion or failure. A failed status request never submits a download. Failed jobs offer an explicit retry; discovery checks the old job and prevents concurrent retries from queuing duplicate work.

Discovery job IDs persist in SQLite. Recent jobs also persist in this browser, including up to 20 finished jobs, so closing the dialog or reloading does not lose them. Open the Link tab or History to resume checking progress.

In Discovery → History, older entries without saved progress offer **Resend to downloader** and **Return to inbox**. Failed jobs and jobs the worker no longer knows about also offer retry and return controls. Returning a set clears its old job reference and makes it importable from the inbox without submitting anything. Resending gets a job ID so progress can be tracked. Active or completed jobs cannot be reset, and a temporary status outage does not permit a resend. Recovery and import requests for the same set are serialized to prevent simultaneous clicks from submitting duplicate work.

Run `cargo test -p reitunes downloads` and `cargo test -p reitunes discovery::tests::job_ids` for the worker contract and persisted retry checks. From `reitunes-web`, run `npm run test:e2e -- e2e/downloads.spec.ts e2e/discovery.spec.ts --retries=0` for the UI scenarios. These tests use fake workers and do not download media.

## Future work

This is entirely single-node right now. I'm not sure whether to forge ahead with the original multi-node offline-first vision. It still appeals to me, but:

1. I'm not 100% offline very often
2. A web UI makes it especially tempting to just have a single central server
   1. If I'm already paying the complexity tax (HTTP requests, split brain thing) for web... maybe I should take advantage of that instead of treating this like a normal desktop app?
