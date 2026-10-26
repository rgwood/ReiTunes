# Audio normalization

These scripts adjust short MP3s at their existing cloud URLs, so browser and
Sonos playback use the same normalized audio. They do not create cloud copies or
re-encode the audio. M4As and recordings of 15 minutes or longer are excluded.

The target is −18 LUFS, using MP3Gain's roughly 1.5 dB steps. Gain is reduced when
necessary to keep true peaks below −1 dB. Dynamic recordings can therefore remain
quieter than the target. Silent recordings are left alone.

## Run a batch

Run these commands from the repository root. Supply the production dotenv file
as a path; the scripts read its S3 settings without executing it or printing keys.
FFmpeg, ffprobe and MP3Gain must be installed. Use `--mp3gain /path/to/mp3gain` if
MP3Gain is not on `PATH`.

```sh
uv run scripts/export_audio_inventory.py artifacts/audio-inventory.json
uv run scripts/normalize_mp3s.py \
  --env-file reitunes/prod.env \
  --inventory artifacts/audio-inventory.json \
  --directory artifacts/normalization-library
```

Without `--apply`, this prepares and verifies local files only. Add `--apply` to
replace the cloud objects. `--limit 5` processes the first five eligible files;
`--workers` accepts 1 to 8. Refresh the inventory and repeat the same command to
include new imports. No service or recurring job is installed by these scripts.

Each replacement checks measured loudness and peaks, audio properties, song tags,
and whether undo restores identical decoded audio. Uploads use an ETag condition
so an intervening object replacement is rejected. After upload, the script checks
the full object hash and anonymous byte-range access, which playback and seeking
need. It records the normalization policy on the object to avoid repeated gain.

The batch writes `progress.json`, `results.json` and a directory per storage key.
Each directory contains `receipt.json` and an untouched `original.mp3` for files
that changed. Adjusted working files are removed after upload verification.
Original backups are local, excluded from Git, and retained until you remove
them after checking playback. Rerunning resumes uncertain uploads and retries
failures. It does not overwrite an original backup with a newly replaced file.

## Restore selected files

Pass the exact receipt paths for the songs to restore. The first command checks
that local originals are intact and cloud files still match this batch:

```sh
uv run scripts/restore_normalized_mp3.py \
  --env-file reitunes/prod.env \
  artifacts/normalization-library/FILE_DIRECTORY/receipt.json
```

Add `--apply` to restore those originals. This refuses to overwrite later external
changes. The five-song trial has its own `normalize_mp3_trial.py restore` command
and manifest format; keep its original trial directory for rollback.

## Toward normalization on import

This is a manual batch for now. Nothing in the import paths runs it, so songs
added after the last batch play at whatever volume they arrived with. Check for
them by looking for objects without `x-amz-meta-reitunes-normalization`.

All imports end at the server's `/api/upload` or `/api/add`, so the server is the
natural place to automate this. The fit is a background job queued after the item
is created, like `durations::import`. It would normalize the stored object in place
using this policy and set the same metadata. Things to sort out first:

- `mp3gain` has to be installed on `spudnik`. The batch used a binary extracted
  from the Debian `mp3gain` 1.6.2 package.
- Eligibility needs a duration. `/api/add` only records one when the caller sends
  `duration_seconds`; otherwise it appears after the first playback.
- M4As and recordings of 15 minutes or longer stay excluded.

## Checks

```sh
uvx --with-requirements=scripts/normalize_mp3s.py ty check \
  --extra-search-path scripts scripts/normalize_mp3*.py \
  scripts/export_audio_inventory.py scripts/restore_normalized_mp3.py \
  scripts/test_normalize_mp3s.py
uv run scripts/test_normalize_mp3s.py
```
