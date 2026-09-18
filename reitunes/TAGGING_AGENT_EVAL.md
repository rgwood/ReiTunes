> Historical Python pilot, retired. Current production and evals use the [shared Rust engine](../tagging-engine/README.md). The commands and production-status statements below describe the old experiment only.

# MusicBrainz tool-use pilot — 17 September 2026

This is a retrieval and integration pilot, not a tag-accuracy benchmark. Production remains unchanged.

The agent uses GLM 5.3 Flash through the official Z.ai provider, high reasoning, the existing price caps and 12,000 output-token limit. It starts with the existing Python lab collector's evidence, then can search artists, search recordings, and look up returned MusicBrainz IDs. It returns the existing tags format plus an evaluation-only `research` field identifying its artist/recording candidates and explaining uncertainty.

The fixed batch has seven cases: a real Moonface control, a copy with YouTube/filename decoration, a misspelled artist, a Four Tet set title with its artist field deliberately removed, an impossible Robbie Basho live version, an ambiguous title without an artist, and an invented title. Five cases have expected artist IDs; two require artist abstention. Four require recording abstention. Expectations were defined before model calls and withheld from the model.

This is a deliberately small stress test. Three positive cases share Moonface, and one decorated title repeats the clean control in the same batch. That makes cross-item evidence reuse possible and is not an independent test of recovering an unfamiliar song. No audio fingerprints or human listening labels establish local recording identity. A retrieved recording candidate is not scored as a verified file match.

The baseline is `scripts/tagging_musicbrainz.py`, not an invocation of the Rust production worker. Its relevant exact-name matching is similar, but its Unicode normalization and handling of partial lookup failures differ. The pilot does not establish production equivalence or the quality of final tags.

Each run permits at most five model requests, four tool-use rounds, and sixteen valid tool executions. Tool arguments and final results are validated. An entity lookup must reference an ID returned for the specified item; citations must reference that item's supplied evidence. Queries are escaped and only MusicBrainz endpoints are reachable. Invalid/ambiguous identities are not written to the library. No web search, audio access, or production writes occur.

Calls use a local SQLite cache seeded from the existing lab cache, retaining the three-second spacing and bounded 429/503 backoff. Later pilots also reuse successful results from earlier pilots. Consequently, repeat timing is largely warm-cache timing, not independent cold-start or upstream reliability measurement.

## Results

The three final trials are in `target/tagging/agent-eval-20260917-v3`. The fixed collector supplied the expected artist candidate for 2 of the 5 known-artist cases. In each agent trial, actual tool results plus baseline evidence covered 4 of those 5. This counts a correct candidate appearing in retrieved evidence, not a validated identity assertion or correct final tag.

| Trial | Expected artist candidates retrieved | Accepted final result | Model time | Reported cost |
| --- | --- | --- | --- | --- |
| Fixed lookup baseline | 2/5 | Not a model-output test | — | No model call |
| Agent 1 | 4/5 | No: mistyped artist UUID | 84.2 s | $0.00285774 |
| Agent 2 | 4/5 | No: citation outside that item's supplied sources | 98.2 s | $0.00511214 |
| Agent 3 | 4/5 | No: artist ID not retrieved for that item | 95.5 s | $0.00359604 |

The model times include all successful model calls, including format correction, but exclude tool execution and the baseline collector. The three trials cost $0.01156592. Including both earlier failed pilots, reported cost was $0.01823129. The provider-rejected HTTP 404 request supplied no usage record, so its billing is not independently verified by this total.

The trials repaired `Moonfaec` to `Moonface` and searched a cleaned decorated title successfully. Two recovered the artist for the decorated title; the third recovered Four Tet from a title with its artist field empty instead. The initial exploratory pilot also demonstrated correcting the truncated album name from `Julia With Blue Jeans` to `Julia With Blue Jeans On`.

All three final outputs left recording IDs unset for the four recording traps, and all left the invented title unidentified. However, trial 3 assumed Moonface when searching the artist-less title `Barbarian`, then reported Moonface as the artist. Its own query had introduced the artist assumption. This is a real failure to preserve uncertainty, even though it withheld the recording ID. Shared artists elsewhere in the batch may have encouraged that assumption; the experiment does not isolate its cause.

Trial 1 changed `bc68` to `bbc68` inside Moonface's UUID. Trial 2 reused the correct artist URL for tracks whose tools had returned a recording credit, but had not attached the artist-detail evidence to those tracks. Trial 3 reused an artist ID from another item's evidence after the attempted cross-item lookup was rejected. These failures were blocked rather than repaired silently. The score file labels examination of rejected outputs as diagnostic only; none were published or counted as accepted.

One of the three final trials needed a JSON-only correction; removing tools from that correction request worked. An empty album argument was omitted in all three trials and caused a rejected tool invocation; the interface should make that field optional instead of wasting a model round. Two new MusicBrainz network calls in the final trials both returned HTTP 200. Most results came from cache, so this is too little uncached traffic to estimate reliability.

My conclusion: the agent can retrieve evidence the fixed collector misses, but the current loop is not ready to replace production. Next, use short server-issued candidate/source handles instead of asking the model to copy UUIDs and URLs; make optional search fields optional; support explicit shared-artist evidence attachment without relaxing per-track provenance; and test ambiguous titles without allowing an uncorroborated artist assumption to become a match. Then rerun these cases plus a broader set without a clean duplicate beside a damaged title. The existing fast path should remain, with research reserved for unresolved cases.

## Integration failures retained

- `target/tagging/agent-eval-20260917-v1`: the first attempt performed useful research but prefixed its final JSON with prose. The unchanged strict parser rejected it. Three billed calls cost $0.00363399; this is a failed final output, not a successful tag run.
- `target/tagging/agent-eval-20260917-v2`: another final response included prose. The bounded correction request used `tool_choice: none`, but OpenRouter returned HTTP 404 because the pinned Z.ai route did not support that value. Four successful billed calls cost $0.00303138; the rejected request had no usage/cost record. The model also omitted a required empty album argument once, which the tool validator rejected and the model corrected.
- The next version removes both `tools` and `tool_choice` from correction/final-budget requests. A format correction consumes the existing five-call budget; it is not an unbounded retry. Failed requests and outputs remain in the artifacts. The main loop records failed trials rather than silently replacing them.

## Reproduction

```sh
UV_CACHE_DIR=target/uv-cache uv run scripts/tagging_agent_eval.py \
  --key-file /path/to/openrouter.key.txt \
  --out target/tagging/agent-eval-new --repeats 3
UV_CACHE_DIR=target/uv-cache uv run scripts/tagging_agent_score.py target/tagging/agent-eval-new
UV_CACHE_DIR=target/uv-cache uv run scripts/test_tagging_agent_eval.py
```

The output directory must not exist. Never rerun a saved request whose billing outcome is unknown. `--seed-cache` selects an existing cache to copy into the new run. Keys are read from the supplied file and are not recorded in request artifacts. Cases, exact model requests/responses, tool results, per-call latency/cost, failures, and scores are saved under the ignored output directory.

## Rate limiting

MusicBrainz's [rate-limit guidance](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) distinguishes User-Agent, source-IP, and global-load rejection. Its [API documentation](https://musicbrainz.org/doc/MusicBrainz_API) requires no more than one request per second and a meaningful User-Agent. We already identify the client and wait three seconds.

An adaptive interval starting slightly above one second could reduce deliberate waiting, with backoff and jitter on 429/503. That would need a separate transport experiment; this pilot keeps spacing constant. A limiter must cover all requests sharing an egress IP, not just each agent independently. Retaining cached entity data and deduplicating repeated artist/recording lookups avoid requests entirely. The current code already caches results, bundles multiple relationship types in lookup requests, and persists cooldowns.

The agent can improve query selection, but each extra model round adds latency and cost. It cannot fix upstream outages, missing database entries, or uncertain local-file identity. Higher concurrency is not a way around MusicBrainz's IP limit. No transport speedup or reliability improvement is claimed from this pilot.
