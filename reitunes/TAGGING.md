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

The queue and MusicBrainz cache persist across restarts. The worker waits 750 ms for import bursts, then runs one shared agent session for up to 20 tracks. Initial evidence exceeding the 48 KB batch budget is split without truncation. Only one session runs at a time. New/changed metadata is checked before model work and again before publishing each result. Interrupted unpaid research resumes after restart; interrupted agent sessions require explicit retry because model calls may have been billed.

Production now calls the same Rust engine as the live-eval and offline replay commands. The model receives MusicBrainz artist search, recording search, entity lookup and explicit evidence-sharing tools, using short handles resolved and checked by Rust. It starts with cached collector evidence, can revise queries, and can share research across related tracks. Inference remains bounded to six model calls, sixteen tool attempts and two final-output corrections per batch. All responses and reported costs are retained, including rejected answers. Transport/HTTP errors require explicit retry.

`tagging_runs` describes an entire batch session; `tagging_agent_events` durably records each exact model request before sending, then its response, cost, tool trace and validation outcome. `tagging_run_items` retains per-track publication/discard/failure status. Existing single-call history remains readable. Generated tags live in `tagging_items`, while human additions/removals/reasons remain in `tagging_labels`.

See [the shared engine documentation](../tagging-engine/README.md) for the architecture, provenance checks, cache/backoff budgets and exact experiment commands. See [Rust evaluation results](../tagging-engine/EVAL_RESULTS.md) for measured improvements and limitations. The Python inference CLIs are retired; historical pilot reports and the old browser lab are archived reference material.

## Verification

```sh
cargo test -p tagging-engine
cargo test -p reitunes -- --skip llm::tests
```

The engine tests cover tool-use replay, sharing, typo/decorated metadata, ambiguous names and recordings, version conflicts, unsupported citations, database-tag evidence, bounded recovery and missing billing data. Production adapter tests verify persisted requests before sending, actual tool dispatch, human corrections, queue deduplication, stale results, restart recovery and cost accounting. The skipped `llm::tests` are live calls for the separate filename-metadata extractor.
