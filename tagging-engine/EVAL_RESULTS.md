# Rust agent comparison — 17 September 2026

Production and this comparison call `tagging_engine::run`. The fixed mode uses the previous Rust collector, request and parser; the agent mode starts with that same evidence and adds the shared MusicBrainz tools. Both use official Z.ai GLM 5.3 Flash, high reasoning and the existing provider restrictions. Expectations are defined in `eval-cases.json` and withheld from the model.

The final comparison is `target/tagging/rust-agent-v2`: nine cases in batches of five and four, with two repeats of each mode. The typo, decorated artist and embedded artist cases have no clean duplicate beside them. Two cases have no identifiable artist; three more are live/remix version traps. This is a small targeted regression set, not a representative sample of the library.

| Measure, summed across both repeats | Fixed collector + model | Tool-using agent |
| --- | ---: | ---: |
| Expected artist candidates retrieved | 6/14 | 13/14 |
| Accepted final batches | 4/4 | 4/4 |
| Accepted final artist candidates correct | Not emitted by old schema | 13/14 |
| Unsupported final artist claims | Not emitted by old schema | 0 |
| Recording identities asserted on ten trap instances | Not emitted by old schema | 0 |
| Positive items with at least one rubric-useful tag | 13/14 | 14/14 |
| Complete abstention on four unknown-item instances | 3/4 | 4/4 |
| Accepted citations / invalid citations | 11 / 0 | 32 / 0 |
| Model calls | 4 | 18 |
| Tool attempts | 0 | 19 |
| Output corrections | 0 | 5 |
| Session latency range, excluding shared initial collection | 19.2–26.6 s | 81.1–132.9 s |
| Total reported model cost | $0.00461922 | $0.01735336 |

Retrieval alone does not count as successful tagging. On both difficult-batch repeats, the agent retrieved all three expected artists, returned all three correct candidate handles in an accepted output, and produced a rubric-useful tag for each. It corrected `Moonfaec`, removed Four Tet's Topic/filename decoration, and found Robbie Basho in the title. The generic `Barbarian` and invented-title cases both abstained. In one second-batch repeat, Four Tet's artist candidate for the live set was still unresolved; the output remained valid and used conservative metadata/inference instead.

The usefulness score is deliberately modest: at least one tag must match a predeclared small set of useful genres/instruments/formats. It is not full tag precision, and it misses synonyms. The strongest measured gain is retrieval and supported identity handling, not a large improvement in browsing tags. The fixed model often knew enough to produce useful tags without database retrieval.

## Failures caught and remaining weaknesses

An earlier Rust iteration is retained in `target/tagging/rust-agent-v1`. It exposed namesake ambiguity, repeated requests during a MusicBrainz 503 cooldown, and attempts to cite ineligible recording/release handles. The final implementation uses an independently matching original title/album to disambiguate namesake artists, deduplicates repeated tool calls, and forces finalization when a whole round repeats prior calls. It also rejects a generic title that merely happens to equal an artist name.

The final runs still needed five correction calls across three agent sessions. Failures included a missing `sources` field, an ineligible recording handle, and an `acoustic guitar` database tag without a matching supplied tag/credit. The engine fed back the validation error and accepted only the corrected output. There were no published unsupported handles or malformed results in these four sessions; that is not a guarantee for future runs.

I reviewed the accepted fixture outputs as well as the counters. Some tags are less useful than others: `guitarist` describes an artist more directly than a recording. Some prose overstates search coverage (“not found anywhere”), and high-confidence `live`/`remix` labels can reflect an explicitly supplied but intentionally dubious filename. The recording IDs remained unset on those traps, but the text and inferred tags still need occasional human correction. The engine has not heard the audio and cannot verify the file's identity. We should not turn these small-set scores into a musical accuracy claim.

The additional research is inexpensive but noticeably slower. The first iteration encountered a real MusicBrainz 503/backoff episode and one trial lost useful retrieval as a result. The final run reused the persistent cache and cannot establish cold-cache latency or upstream reliability. Cache hits, network requests, per-tool errors, latency and reported costs are retained in the artifacts. Missing usage costs are explicitly counted; none were missing in the final comparison.

## Reproducibility and verification

All eight final sessions replayed successfully against the final engine: exact model requests, tool queries, validation decisions and accepted predictions. One real public-metadata agent session is checked in under `test-fixtures/live-agent` and runs in the default offline test suite. The broader artifacts retain cases, config, code revision plus source snapshots, prompts, requests, raw MusicBrainz replies, tool traces and outcomes. The final code's additional bare-title identity guard was also tested with an adversarial fixture; all eight saved sessions still replay exactly.

Validation: 76 production backend tests passed (one unrelated live-network test ignored and six separate filename-LLM tests filtered out); 12 engine/cache/replay tests passed; the engine passed Clippy with warnings denied. The production adapter test confirms tools are present, actually dispatched, and journaled before model calls, and that human removals/reasons survive publication. Live rollout verification uses real library tracks and the same per-call trace table; it is separate from these evals and is reported with the deployment outcome.

See [the engine README](README.md#running-experiments) for live, replay and rescore commands. The Python tagging CLIs are retired; their historical pilot remains documented separately.
