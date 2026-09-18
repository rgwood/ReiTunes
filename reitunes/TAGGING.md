# Library tags

GLM 5.3 Flash is the production tagger, using OpenRouter's official `z-ai` provider with high reasoning and no provider fallback. MusicBrainz supplies cached artist, recording and release evidence first. The model does not hear audio or search the web.

Generated tags apply automatically. There is no approval queue or default review prompt. Click a tag in the grid or editor to search the whole library for that tag; this replaces the previous search and clears the collection or playlist selection. The toolbar's **Tags** button opens an optional tag directory. The Tags column follows artist, album, track number and plays.

To correct a tag, open the track's **…** or **+N** tag menu, or **Manage tags** from its context menu. Remove a tag immediately, optionally save a reason, restore a removed tag, or add your own. Evidence and notes stay collapsed until requested. Human corrections and reasons are stored in SQLite separately from model output and survive regeneration; applying generated tags does not create human approval records.

Use the regular search field: `tag:dj-mix`, `tag:house tag:vocal`, or `artist:"Four Tet" tag:electronic`. Tag matches are exact and case-insensitive; multiple terms must all match. Removed tags (including previous uncertain judgments) do not count as matches. Stale generated tags stop affecting filters when title, artist, album or file path changes; human-added tags remain.

## Classification

Provide `OPENROUTER_API_KEY` to the server process. A runtime value takes precedence over a compile-time value. The browser never receives the key. Without a key, manual tagging still works and automatic suggestions are disabled.

New file uploads, completed link imports, and edits to title, artist, album or file path queue suggestions automatically. Classification runs asynchronously and does not delay the import or edit response for MusicBrainz or model calls.

At startup and every 55–65 minutes, a background sweep queues all previously unclassified tracks without manually accepted tags, plus tracks whose classification metadata has changed. The randomized interval avoids synchronized hourly bursts. Queue entries persist, deduplicate against immediate import/edit hooks, and are processed in batches of up to 20. The sweep never regenerates unchanged successful results, deliberate empty results, or failures; it also does not reintroduce human-removed tags. A metadata change permits a fresh attempt, while unrelated play counts, favorites and bookmarks do not. Human tags and correction reasons survive regeneration.

**Tags → Automatic tags** retains the optional bounded manual queue action. The selected-track editor only generates or refreshes that track. Failed tracks have an explicit retry action, so an interrupted billable call cannot be charged repeatedly by the sweep. Without an API key, both automatic enqueueing and processing are disabled; manual labels remain available.

Progress distinguishes waiting, metadata lookup, metadata ready and model generation inside the optional tag panel. The toolbar's Tags button shows a count while work is running, or an indicator for failures. Completion is quiet: the new tags appear in the grid and search automatically. Recent outcomes remain available under Automatic tags.

The queue and MusicBrainz cache persist across restarts. Queue entries remain per track, but the worker waits 750 ms for bursts of imports and claims up to 20 entries for one model request. Only one request runs at a time. Batches exceeding the request byte budget split without truncating evidence; a single oversized item fails before any paid call. Isolated imports use the same request format with one item. Queued work and interrupted metadata research resume after restart; interrupted model calls become failed and require explicit retry because they may already have been billed. Failed calls never erase human judgments. Results for changed or deleted items are discarded individually.

MusicBrainz requests are spaced at least three seconds apart, with at most 15 requests per item including retries. HTTP 429/503 responses receive bounded backoff respecting `Retry-After`; cached artist evidence remains usable if a recording lookup is deferred. Matching metadata identifies candidates, not a fingerprint-verified local recording. A missing vocal relationship does not mean instrumental, and a DJ's genre does not establish every track in a set.

The [shared request definition](tagging-request.json) preserves the prompt, schema, official provider, high reasoning and 12,000-token output budget from the saved 20-track eval `run-random20-20260917T054359Z`. The Rust worker and the Python eval harness both load it. Each request is limited to 48 KB, with provider price caps of $0.15/$0.50 per million input/output tokens. A received completion that fails validation gets one fresh attempt with the same settings and cached evidence. Both attempts retain their response and cost records. Transport failures, HTTP errors and interrupted calls require explicit retry; the sweep never restarts failed attempts. There are no search charges.

Exact request, evidence snapshot, raw response, timestamps and reported cost are retained once per model call in `tagging_runs`. `tagging_run_items` maps each opaque request ID (`t01`, etc.) to its library ID and metadata hash, and records whether that member was published, discarded or failed. The legacy `ItemId` and `MetadataHash` columns on `tagging_runs` identify its first member. A batch's cost is not multiplied across its tracks: results link to the run, and per-track cost is only populated for singleton calls. Suggestions and work status live in `tagging_items`; human judgments live in `tagging_labels`. These tables are added when the existing database initialization runs.

Missing, duplicated or invented response IDs and truncated/invalid outputs are rejected without publishing partial suggestions. If the one automatic retry also fails, the batch remains failed for explicit retry. Results may arrive in any order. Stray closing backticks after a complete valid JSON object are ignored, but extra prose, unknown fields and additional JSON objects are rejected. Every citation must belong to that particular item's supplied evidence; a citation on an inference does not promote it to database evidence.

Matching the request restores the evaluated inference setup, not an accuracy guarantee. Different batch sizes, batch composition and newly collected evidence can change results. The original 16-track pilot used 8,000 output tokens; the later 20-track eval used 12,000. The initial production implementation used a rewritten singleton prompt and 4,000 tokens and was not covered by either eval. Isolated imports and smaller batches need separate quality review.

The experimental lab remains separate. Its per-tag reasons save in browser storage and accompany exports; they are not automatically imported into production judgments. Existing lab labels without reasons remain compatible.

## Verification

The Rust tests replay the saved 20-track request/response, check one HTTP request for 20 jobs, reordered/missing/duplicate/invented IDs, concurrent edits and deletion, cost accounting, batch failure, queue deduplication, restart recovery, reason persistence, provider constraints, source validation and cached evidence during cooldown. Frontend tests cover responsive grid editing, combined filters, human overrides, manual tags without a key, and reload/export/import of lab reasons.

```sh
cargo test -p reitunes -- --skip llm::tests
cd reitunes-web
npm test
npm run build
npm run lint -- --quiet
npm run test:e2e -- e2e/library-tags.spec.ts e2e/tagging.spec.ts --retries=0
```

The existing `llm::tests` make live calls to the separate filename-metadata extractor and are excluded from this offline regression run.

The ignored `live_singleton_comparison` test makes exactly three paid calls using fixed cases from the archived 20-track eval and its cached evidence. It requires an explicit `TAGGING_EVAL_KEY_FILE` path and runs only with `cargo test -p reitunes live_singleton_comparison -- --ignored --nocapture`. It saves exact requests/responses in a separate SQLite database and a comparison JSON under `target/tagging/singleton-eval-*`. It measures disagreement with the saved batch, not accuracy; normal test runs never execute it.
