> Historical Python pilot, retired. Current production and evals use the [shared Rust engine](../tagging-engine/README.md). The commands and production-status statements below describe the old experiment only.

# Tagging lab

The review prototype works with a 16-item sample from the real library. Open the [local tagging lab](http://127.0.0.1:4173/tagging.html).

The experiment compares cached MusicBrainz evidence with GLM 5.3 Flash and GPT-5.6 Luna at high reasoning. You chose GLM for the [production implementation](TAGGING.md), pinned to the official `z-ai` provider with fallbacks disabled. Existing browser labels survived the update and are reflected in the review scores. This remains a partial review rather than a statistical accuracy benchmark.

## Current pilot results

### Production batching correction

The first production implementation changed to one track per call, rewrote the prompt and reduced the output budget to 4,000 tokens. Those changes were not validated by the batch evals. Production now shares [one request definition](tagging-request.json) with the GLM eval harness: the prompt, schema, official Z.ai provider, high reasoning and 12,000-token budget from the later saved 20-track run `run-random20-20260917T054359Z`. The earlier 16-track pilot below used 8,000 tokens. Offline tests compare the production request with the saved request and replay its response through production validation.

A separate singleton spot check made three calls on the same cached evidence, costing $0.00126394 in total. Each case used the shared production request with one item. Compared with the saved batch:

| Track | Difference in singleton output |
| --- | --- |
| Empty Printworks 2020 Set | Kept DJ mix/house/deep house; replaced high-energy with electronic, club/dancefloor and a weak mixed-bag-vocals guess. |
| Four Tet live from Lost Village 2025 | Kept electronic/festival/club; replaced live-set with dj-set and live-recording. |
| Downtime | Kept mashup/electronic; replaced album with sample-based and the unhelpful vocal-status-unknown tag. |

The first singleton response initially failed production's narrower tag-character validator because of `club/dancefloor`, which the evaluated schema permits. That mismatch was corrected, and all three saved responses now pass offline replay without further billing. Exact requests, raw responses and original run outcomes remain under `target/tagging/singleton-eval-35f12a18-c21c-4dca-8461-299f83a67e8c`; regression fixtures retain the responses.

This is three fixed cases with one sample each, not an accuracy estimate or proof that singleton and batch quality match. Both outputs contain questionable tags. Smaller batches, changed batch composition and the Rust evidence collector still need quality review on representative imports. The older batch scores must not be presented as singleton scores.

The two calls in `run-20260917T044040Z` returned predictions for all 16 items. They cost $0.01174555 together, with no web-search charges.

| Model and provider | Tags | Batch latency | Reported cost |
| --- | ---: | ---: | ---: |
| GLM 5.3 Flash, Z.AI | 47 | 45.122 seconds | $0.00270610 |
| GPT-5.6 Luna, OpenAI | 41 | 59.644 seconds | $0.00903945 |

GLM's JSON was followed by two stray backticks. The parser now permits a trailing Markdown delimiter, records that formatting issue and still validates every field and ID. Extra prose and second JSON objects are rejected. Revalidating the saved response made no additional completion calls. The original response remains archived.

Both models cited the cached artist page for the `folk` suggestion on “Death Song”. GLM also guessed `low-energy` from artist context, so higher reasoning has not eliminated weak evidence. The current comparison has only one call per model and sparse database coverage. Across all completed experiments, reported costs total $0.03033662, plus the unknown cost of an interrupted request.

## MusicBrainz first

`scripts/tagging_musicbrainz.py` caches normalized searches and recording, artist and release lookups in local SQLite. Repeated tracks and artists reuse the same MBID entries across runs. The collector spaces uncached requests at least 3 seconds apart and allows at most 60 requests per invocation, including retries. HTTP 429/503 responses get at most two retries with 10- and 20-second minimum backoffs, respecting `Retry-After`. A third failure pauses the run with a persisted cooldown. A requested wait longer than 60 seconds defers work instead of blocking the invocation. Failed requests never become cached empty results.

Matching requires a unique exact title and artist match among the returned candidates; an album match can narrow multiple candidates. This is a candidate identity, not fingerprint verification. Release editions stay unresolved when more than one matches. Artist community tags remain artist evidence, not proof about every recording. Missing vocal relationships never establish that a recording is instrumental. See the [MusicBrainz search API](https://musicbrainz.org/doc/MusicBrainz_API/Search).

The model receives this cached evidence with source URLs. The UI exposes candidate status and unresolved research reasons. A verified source link means the URL was supplied in the evidence, not that the model's interpretation is correct. Cached responses currently have no automatic expiry; refresh/invalidation is future work.

The evidence supplied to the existing model pilot covered only “Death Song”. That snapshot remains archived with the predictions; later collection does not retroactively ground an older model output.

### MusicBrainz failure investigation

The earlier collector abandoned the entire invocation after a single 503 and incorrectly labelled all later, unattempted lookups as errors. It also discarded HTTP response bodies, so my original explanation was too broad. Deferred items now have a separate status, and snapshots include actual request URLs, HTTP statuses, selected response headers and error bodies.

The failure was reproduced on Quantic's artist-detail lookup after a successful artist search, with three seconds between requests. MusicBrainz returned `The MusicBrainz web server is currently busy. Please try again later.`, `Retry-After: 0`, and a rate-limit remaining count of 13. Identical artist searches succeeded in curl and httpx, with and without a trailing slash. This points toward transient server-side load rather than malformed queries or a Python-client problem; remaining-capacity headers alone cannot conclusively distinguish every upstream limiter. MusicBrainz documents [503 responses for both throttling and global load](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting).

Bounded retries now tolerate these temporary failures. Legitimate ambiguity is kept separate: “Blue Crystal Fire” returns both live and studio recordings and the local album field does not distinguish them.

The diagnostic rerun completed all 16 items with 29 successful network requests, 6 cache hits and no HTTP errors or deferred items. It produced artist evidence for 12 items and recording candidates for 3. A second pass used 35 cache hits and zero network requests. The successful live pass needed no retries, so recovery demonstrates the transient service failure cleared; the retry behavior itself is covered by offline tests. No additional model calls were made during this investigation, and the review page still shows predictions from the earlier evidence snapshot.

Paid web search is off and is never triggered automatically. Unknown recordings, DJ tracklists, vocal uncertainty and conflicting metadata are reasons for further research. An optional bounded web pilot exists in the runner, but no paid web-search calls have been made. Choosing individual ambiguous items for search remains future work.

## Modern metadata baseline

The low-reasoning run `run-20260917T041512Z` cost $0.00821026 across four calls. Both GLM calls used DeepInfra and failed strict item-ID validation; both Luna calls returned valid output. Failed outputs and their costs are retained. Those failures should not be generalized to the official Z.ai provider.

The MusicBrainz harness uses short enumerated IDs and maps them back to the original IDs only after validation. It does not repair a model's incorrect IDs. Provider, evidence and harness changes mean this is not a controlled reasoning-only comparison.

An unpinned high-reasoning request (`run-20260917T043448Z`) was interrupted after several minutes without a completed response. Its provider and billing are unknown; the request archive remains intact. The first pinned request returned HTTP 404 because the official route's price and format support differ from the aggregate model catalogue. The runner now checks the official endpoint before making calls.

## Earlier baseline

The run is archived locally under `target/tagging/run-20260917T025811Z`. Every call returned valid structured output for all 16 item IDs. Neither model received audio; reported audio-token usage was zero.

| Model | Tags in repeats 1 and 2 | Batch latency in seconds | Total cost | Mean repeat tag overlap |
| --- | ---: | ---: | ---: | ---: |
| Gemini 2.5 Flash Lite | 52, 52 | 11.738, 10.617 | $0.00360241 | 100% |
| GPT-4.1 mini | 40, 39 | 24.898, 13.620 | $0.00677840 | 93.75% |

Overlap is mean per-item Jaccard similarity of normalized tag sets, not agreement on evidence text or confidence. Both second calls reported cached input tokens. Two repeats are too few for a reliable latency benchmark. Cross-model overlap was 43.23% for the first runs; different words such as `dj-set` and `dj-mix` contribute to disagreement.

The strongest candidates were tags stated in titles: `house` for “Instrumental House for the Soul”, `dj-set` for explicit DJ sets, and `jazz` for the Brazilian Bossa Jazz mix. Neither model confused “The Long Run (Original Mix)” with a DJ set. These are observations about the supplied metadata, not audio validation.

Several outputs need particular scrutiny:

- Gemini inferred `energetic` from “SKYTRAIN” suggesting movement, and `quirky` from Moonface's title phrasing
- Gemini marked `vintage` as metadata-supported because Quantic's title contains “Vinyl” and “2014”; those words do not establish the music's vintage
- GPT inferred `instrumental` for both Robbie Basho songs from general claims about the artist's work; it did not establish the vocal content of these recordings
- GPT marked `house` as metadata-supported for “The Long Run (Original Mix)”, although “Original Mix” does not establish genre; its second run replaced `house` with `downtempo`
- both applied artist-level genre expectations to DJ sets despite the prompt warning that a DJ's reputation does not describe every track

GPT abstained on the opaque Four Tet title in both runs. Gemini proposed `experimental`, `electronic` and `abstract`. Gemini's perfect repeat agreement therefore shows stable decisions, not necessarily better decisions.

My next harness change would require a literal supporting field for metadata tags, normalize format synonyms, and demand stronger evidence before proposing energy or vocal tags. Keep broad genre guesses available for review. Evaluate those changes against your saved labels before choosing a model or adding bounded audio excerpts. These observations are recorded here rather than inserted into your human labels.

## Review music

Select an item, listen, then accept, reject or mark individual suggestions unsure. To correct a tag, reject it and add the replacement. Use the reset arrow to undo a judgment. Notes and “Needs another listen” help capture ambiguous cases.

Each tag in **Your labels** has an optional reason field. Reasons belong to your judgment, separately from the model's evidence, and survive changing the verdict, refreshing model outputs, reloads, export and import. Existing labels without reasons remain compatible.

Use `j` and `k` to move between items, `a` to add a tag, and `/` to search. Shortcuts do not intercept typing in fields or operating the audio player. Tab and Enter work on each decision. Filters show favourites, unreviewed suggestions or uncertain items.

Judgments apply to the same normalized tag across models. This avoids asking you to label the same claim twice. Normalization lowercases tags and replaces whitespace with hyphens; it does not merge synonyms. Hide model names to reduce brand bias while judging. The first run from each model appears side by side; exports contain every repeat.

Labels save in this browser’s local storage, separately from predictions. Keep using the same origin, `http://127.0.0.1:4173`, to see them. They are not synced to a server. Export review downloads a portable JSON backup with your labels, notes, predictions, provenance and scores. Import adds labels; existing local edits win conflicts. Corrupt imports are rejected before changing labels. If browser storage fails, the page warns you to export before closing.

## Sample and evidence

On 17 September 2026 UTC, the read-only SSH snapshot contained 365 items and 10 favourites. SQLite was opened with `mode=ro` and `query_only=ON`. The script replayed library creation, deletion, metadata, play and favourite events locally.

The purposive sample includes:

- all 10 favourites, including Robbie Basho, Moonface, Neil Cicierega, Quantic and The Avalanches
- Daft Punk’s Essential Mix and Tycho’s Red Rocks DJ set
- Llewellyn’s “The Long Run (Original Mix)” as a single-song format edge case
- 3 recent imports: Yu Su’s “230822”, Tinzo’s house mix, and a Four Tet track with an opaque title

This is a useful test set, not a representative statistical survey. It overweights favourites. Duration is not present in the library metadata and is not sent to the models. The sample includes known DJ-set titles, but the harness must not infer set length from a title alone.

The model input contains item ID, title, artist, album and cached MusicBrainz evidence. It excludes favourites and play counts to avoid preference bias. It excludes audio URLs, filenames, credentials and audio. Each suggestion distinguishes metadata, database evidence and inference. The prompt allows abstention and warns against guessing a whole mix’s sound from the DJ’s reputation.

Human playback uses the existing public object-store URLs. Playback of the first real item was verified in the browser. Neither playback nor review calls the production library mutation endpoints.

## Comparison setup

The default models are `z-ai/glm-5.3-flash` and `openai/gpt-5.6-luna`. The older baseline used `structured-batch-v1` at temperature 0. Current runs use `musicbrainz-batch-v2` with high reasoning effort and omit temperature because Luna does not support it. GLM requests specify `provider.only: ["z-ai"]` and `allow_fallbacks: false`. This is not an exact settings match to the earlier runs.

The current prompt is `musicbrainz-cautious-v1`. Each default invocation makes 4 calls: 2 repeats per model on identical evidence. Use `--repeats 1` for a two-call pilot. Repeat agreement measures consistency, not correctness. Use `--models MODEL_A MODEL_B` to compare another pair explicitly.

The [OpenRouter model catalogue](https://openrouter.ai/api/v1/models) and [GLM endpoint catalogue](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints) were checked on 17 September 2026 UTC. The official Z.ai endpoint advertises JSON mode, but not enforced JSON Schema. Its schema is included in the prompt and checked locally. Luna uses enforced JSON Schema plus the same local validation.

| Model | Input per million tokens | Output per million tokens | Conservative cost for 2 calls |
| --- | ---: | ---: | ---: |
| `z-ai/glm-5.3-flash` (Z.ai) | $0.15 | $0.50 | $0.02240 |
| `openai/gpt-5.6-luna` | $0.20 | $1.20 | $0.03840 |

The total bound at those prices is $0.06080 for four calls, or $0.03040 for a two-call pilot. The harness checks current catalogue prices, limits each database request to 48,000 serialized input bytes and 8,000 output tokens, and refuses a call priced above $0.05. Metadata-only requests use a 12,000-byte limit. Provider price caps disallow higher token rates and per-request charges. Reasoning shares the output budget. There are no automatic retries. With 4 calls maximum, the price-change guard permits at most $0.20 per invocation. This is an API estimate, not an account spending limit. See [OpenRouter provider price limits](https://openrouter.ai/docs/guides/routing/provider-selection#max-price).

Every completed call records exact request and raw response, requested and returned model, provider, prompt hash and version, evidence snapshot, harness version, token usage, reported cost and wall-clock latency. Invalid schema, missing or duplicate item IDs and truncated responses are recorded as failed attempts; the runner continues to the next scheduled call without retrying. A provider can still write unsupported claims in an evidence sentence; human review remains necessary.

The credential was read from the user-supplied plain text file without displaying or copying it into experiment artifacts. For later runs, use `--key-file`, `OPENROUTER_API_KEY` in the environment, or `--key-env-file` for a dotenv file. Request archives contain payloads, not authentication headers.

## Run locally

From the repository root, keep caches on disk in this worktree:

```sh
export UV_CACHE_DIR="$PWD/target/uv-cache"
export UV_TOOL_DIR="$PWD/target/uv-tools"
uv run scripts/tagging_sample.py
uv run scripts/tagging_experiment.py --prepare-only
uv run scripts/tagging_experiment.py --catalogue-only
uv run scripts/tagging_musicbrainz.py
```

The sample command reads the fixed production database path over the configured `spudnik` SSH host. It saves only local metadata. `--prepare-only` replaces the visible experiment with an empty run list; it does not touch human labels or archived runs.

After making the OpenRouter key available to the command environment:

```sh
uv run scripts/tagging_experiment.py
# Or read a plain text key file directly:
uv run scripts/tagging_experiment.py --key-file /absolute/path/to/openrouterkey.txt
# Alternatively, use a local dotenv file without printing its contents:
uv run scripts/tagging_experiment.py --key-env-file /absolute/path/to/local.env
```

Run only one dev server. If the existing server has stopped, start the frontend from `reitunes-web`:

```sh
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

Open `/tagging.html`. This standalone React entry uses the existing frontend dependencies and does not start the Rust server. The dev-only read-only endpoint serves `target/tagging/experiment.json`. A normal production build does not copy the sample, raw responses or labels into its assets.

Local data stays under ignored `target/tagging`: `library-metadata.json`, `sample.json`, `model-catalogue.json`, `experiment.json`, and dated `run-*` directories. New runs appear first in the review page, followed by earlier runs on the same sample. A changed sample is rejected instead of silently combining incompatible datasets. Each new run directory includes its catalogue snapshot. The snapshots contain public pricing and capability metadata. Exports contain personal library metadata; keep them wherever you keep your own backups.

## Score a later run

```sh
uv run scripts/tagging_score.py target/tagging/experiment.json --review /absolute/path/to/reitunes-labels.json
```

The scorer reports accepted, rejected, uncertain and pending predictions per run. Precision is accepted divided by accepted plus rejected; unreviewed and uncertain tags are excluded. Accepted human tags missing from a model’s output are listed as omissions, without pretending your labels define exhaustive recall. Repeated-run and cross-model Jaccard scores measure exact normalized tag overlap. Synonymous tags can lower agreement even when both are useful.

The UI export includes the same per-run judgment counts. Model confidence percentages are self-reported confidence, not accuracy. Do not select a winning model until enough suggestions have human labels.

## Validation and next steps

The frontend build, 40 unit tests, lint and 3 Chromium workflow tests pass. The workflow tests cover correction, reload persistence, export, conflicting imports, malformed data, uncertainty, navigation and preserving labels after a model rerun. Fourteen offline Python tests cover invalid predictions, abstention, scoring, provider pinning, JSON delimiters, search limits, database evidence, candidate ambiguity, cache reuse, transient retry recovery and exhausted retries. All new Python scripts pass `ty`.

```sh
uvx --with-requirements=scripts/test_tagging.py ty check --extra-search-path scripts scripts/
uv run scripts/test_tagging.py
uv run scripts/test_tagging_musicbrainz.py
cd reitunes-web
npm run build
npm test
npm run lint -- --quiet
npm run test:e2e -- e2e/tagging.spec.ts --retries=0
```

Next, review the energy, instrumental and whole-set claims first. The experiment exposed weak evidence for these claims, but their actual usefulness still needs your judgments. Use the exported labels to decide whether a second harness with bounded audio excerpts is worth testing. Import-time classification, persistent production tags, filters and recurring passes remain future work.
