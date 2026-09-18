# Shared MusicBrainz tagging engine

Production and experiments call `tagging_engine::run`. The production queue owns library IDs, metadata hashes, job claiming and publishing; the engine only sees short `t01` IDs, public title/artist/album metadata and MusicBrainz evidence. It cannot write to the library.

`src/lib.rs` owns the model loop, budgets, final-output recovery and accounting. `src/research.rs` owns the four tools, handle registry, evidence sharing and validation. `src/evidence.rs` is the existing production MusicBrainz collector/cache, moved here rather than rewritten. `src/baseline.rs` retains the previous fixed-collector request and validator as an explicit comparison mode of the same engine. Production selects `Mode::Agent`; the eval CLI compares `Mode::Fixed` and `Mode::Agent`.

There is no agent-framework dependency. The small `Model` and `MusicBrainz` traits separate HTTP from replay fixtures. A synchronous recorder saves every request **before** sending it, then responses, tool results, validation errors and the outcome. Production records these in `tagging_agent_events`; evals use flushed JSONL files. This keeps model orchestration out of both adapters.

The official Z.ai provider, GLM 5.3 Flash, high reasoning, no fallback, price caps and 12,000-token output limit still come from `reitunes/tagging-request.json`. That file's old prompt is used only for the fixed baseline. The production agent prompt lives in `agent-prompt.txt`. Both modes use the same compiled request-building and validation code in tests and live runs; the eval runner does not construct a separate prompt or inference loop.

## Research and provenance

The engine starts with the fixed collector's cached evidence. `search_artists`, `search_recordings`, `lookup_entity` and `share_evidence` use short server-issued `s1` handles. The model never has to copy MusicBrainz UUIDs or URLs. Optional artist/album search arguments are actually optional. Searches escape Lucene operators; entity lookups resolve known handles and can only reach the supported MusicBrainz artist, recording and release endpoints.

One search can serve multiple `item_ids`. Entity handles are deduplicated across the batch. Additional tracks can explicitly attach an existing handle with `share_evidence` or `lookup_entity`; application code checks the original metadata before permitting the attachment. A source must be both attached and eligible before it can support an identity or citation. The final parser resolves handles to URLs and retains candidate MBIDs in the trace report, with `status: metadata-candidates-only`.

Artist anchors use the original artist field or a bounded artist-name match embedded in the title. Known filename/Topic/Official Audio decoration is removed; names of at least five characters permit edit distance two. These are conservative heuristics, not identity proof. Multiple namesake artists require corroboration from an independently matching recording title and artist, using the album when needed. Adding an assumed artist to a search never creates an original artist anchor. Generic artist-less titles therefore cannot use that assumption to establish identity.

Recording matching preserves live/remix qualifiers and refuses multiple matching recordings unless the original album uniquely disambiguates them. An artist handle alone cannot establish recording identity. Database tags must match a supplied community tag or performance credit; broader interpretations must be labelled inference. Missing vocal relationships never establish instrumental music. A match remains a metadata candidate, not a fingerprint of the local audio. The model can still make poor stylistic inferences or write overconfident prose; provenance checks are not a general fact checker.

## Budgets and persistence

The defaults are up to 20 items per session, six model calls, sixteen tool attempts, two final-output corrections and a 160 KB model-request ceiling. Corrections consume the six-call budget and remove tools; there is no unsupported `tool_choice: none` request. Identical tool calls reuse their result and a round consisting only of repeats forces finalization. HTTP/transport errors are not retried automatically because their billing outcome can be unknown. Every available cost is recorded, and missing cost records are counted rather than treated as free calls.

The initial collector keeps its 15-request ceiling per item. Additional agent research has one shared 15-request MusicBrainz budget per batch, including backoff retries. Every lookup uses the same persistent SQLite cache and three-second request reservation. HTTP 429/503 cooldowns and bounded backoff remain in effect; cached responses are usable while uncached traffic is deferred. Share a single cache path across eval processes on the same host. Do not create parallel caches to bypass the upstream IP limit.

Production retains per-track queue entries, deduplication, async import/edit hooks, the startup/hourly sweep, and metadata-hash checks before research and publication. The worker processes one batch at a time. Human labels and reasons remain in their separate table and override generated tags. A restart resumes unpaid research; an interrupted agent session is failed for explicit retry because a model call may have been billed. `tagging_runs` now represents a batch session; individual calls and costs are in `tagging_agent_events`. Old single-call runs remain readable. Session cost is not multiplied across its tracks.

## Running experiments

Offline tests, with no model or MusicBrainz network calls:

```sh
cargo test -p tagging-engine
cargo test -p reitunes -- --skip llm::tests
```

Live comparison using the production engine, with output kept outside the library:

```sh
cargo run -p tagging-engine --bin tagging-eval -- live \
  --key-file /absolute/path/to/openrouter.key.txt \
  --cache target/tagging/rust-agent-cache.sqlite \
  --out target/tagging/rust-agent-new \
  --repeats 2
```

The output directory must be new. The CLI refuses a cache containing library/event/tagging tables. It does not import production tracks, submit eval predictions to production, or contain a library publishing adapter. `--cases /path/to/cases.json` selects a different case set using the checked-in `eval-cases.json` format. Each numeric `batch` is one session; keep each batch at 20 items or fewer. Expectations and the usefulness rubric are withheld from the model.

Replay a completed live session without HTTP or billing:

```sh
cargo run -p tagging-engine --bin tagging-eval -- replay \
  --dir target/tagging/rust-agent-new/batch-1-Agent-1
```

Replay checks exact model requests, exact MusicBrainz queries, and final validated predictions/errors. A prompt, tool or validator change that alters the recorded interaction fails replay; use the recorded code revision to reproduce the old behavior. Failed validation sessions can also replay. An interrupted HTTP call with no saved response cannot be replayed as a completion.

The default offline tests include a checked-in real GLM/MusicBrainz session with public fixture metadata. To recompute the rubric and independently check accepted citations on an artifact directory, run `cargo run -p tagging-engine --bin tagging-eval -- score --dir target/tagging/rust-agent-new`. This writes `rescored.json` without making model calls.

Artifacts include cases and expectations, compiled code revision, source snapshots (including dirty eval builds), config, prompt, provider settings, prepared input/evidence, every model request/response, raw MusicBrainz replies, tool results, validation failures, costs and final outcomes. `scores.json` reports retrieval, accepted outputs, final artist candidates, unsupported identity claims, version traps, citations, a predeclared tag-usefulness rubric, latency, tool calls and costs. Retrieval is reported separately from accepted tagging. The fixed baseline did not return explicit identities; its final-identity score is null rather than invented from search hits.

The fixture set covers clean input, typo/decorated/embedded artist names without a clean duplicate in the same batch, ambiguous titles, nonexistent recordings, and live/remix conflicts. It is a small targeted regression set, not a representative accuracy benchmark. Exact tag-vocabulary matching misses some useful synonyms, and musical accuracy still needs human listening/review. Both modes get the same initial Rust-collected evidence; later runs share a warm cache, so these runs do not establish cold-start latency or upstream reliability.

The old Python tagging CLIs are retired and exit with this replacement command. Their code and historical reports are archived reference material, not maintained inference paths. The old browser lab displays archived experiments; current experiments use this Rust CLI.
