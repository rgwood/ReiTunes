# Sonos reliability tests

These tests reproduce selected failures without a Sonos account, real speakers or a production database. They check ReiTunes's recovery behavior; they cannot verify firmware, Wi-Fi, TLS compatibility, codecs or audible output.

## Run the tests

From the repository root:

```sh
cargo test -p reitunes sonos
cargo test -p reitunes cloud_queue::tests
# Broader coverage, excluding the unrelated LLM integration tests.
cargo test -p reitunes -- --skip llm::tests
```

From `reitunes-web`:

```sh
npm test
npm run test:e2e -- --grep Sonos --retries=0
# Repeat the focused scenarios to check timing stability.
npm run test:e2e -- --grep Sonos --retries=0 --repeat-each=3
```

Rust tests use loopback servers and temporary SQLite databases. Browser tests start Vite and mock the ReiTunes API. No production environment file is needed. One socket test deliberately exercises the production 15-second deadline.

## Coverage

| Layer | What it checks |
| --- | --- |
| `sonos.rs` mock servers | Real Sonos client: wire formats, tokens, sessions, takeover, stalled headers/body, lost acknowledgements, readback before retry, revoked/temporarily unavailable refresh tokens and concurrent login |
| `sonos_route_tests.rs` | Real playback handler and authentication, stale-session preflight, confirmed replacement, missing groups, context/item-window callbacks, queue authorization, failed subscriptions and signed event forwarding |
| `cloud_queue.rs` tests | Windows, authorization, identifiers and restart persistence |
| `sonosRequest.test.ts` | Browser deadlines, stalled headers/body, network failure, expired login, proxy errors and takeover conflicts |
| `sonos-resilience.spec.ts` | Stateful fake ReiTunes API: failed/lost pause replies, stale playback/volume polls, output changes, stalled requests and connection recovery |
| `sonos-controllers.spec.ts` | Two independent browser contexts sharing a speaker; reverse-order playback/volume polls; output changes to another group; credential and missing-group recovery messages |
| `sonos-media-session.spec.ts` | Media Session metadata and playback state; play/pause/stop, seeking and track changes; failed commands, lost sessions, handoffs and return to browser controls |
| Existing `reitunes.spec.ts` cases | Output handoff, takeover UI, retries, next/previous, seek and layout |

The browser fixtures do not exercise Rust. The route tests bridge real handlers and fake Sonos, including queue callbacks. The fake never downloads audio.

## Recovery rules and deadlines

A timeout leaves the outcome uncertain. Success requires the expected queue version and item to be playing. If readback is unavailable, stop without resending. Otherwise, allow at most one retry on the same session. Another app taking over requires fresh confirmation.

Transport controls reflect observed playback. Newer observations invalidate old polls, and output changes invalidate old command completions. Playback and volume errors recover independently. Subscription failures do not turn successful playback into failure; polling remains available.

Volume controls immediately display the requested level and remain usable while Sonos responds. Only one volume request runs at a time; additional clicks replace the next requested level. A final status read confirms the speaker volume. Clicks during that read still take effect afterward. Failure discards pending changes, reads back the speaker when possible and shows an error. Output changes discard pending changes for the previous output. Browser scenarios hold command replies and status reads to check coalescing, responsive controls and failure recovery.

Sonos HTTP requests have a 5-second connection deadline and a 15-second total deadline. Queue operations have a 45-second server budget; the browser waits at most 50 seconds. Other browser commands wait at most 35 seconds, followed by at most one 20-second status read. A browser abort does not prove the speaker cancelled the command.

The aggregate-budget test runs the production deadline wrapper with short test durations and several individually bounded steps. The Rust body-stall test sends headers and a partial body, then withholds the rest. The existing header-stall test checks the production timeout.

A refresh rejected with OAuth `invalid_grant` requires reconnecting; it is not retried on every status poll. Temporary refresh failures preserve credentials. Deletion checks the attempted credentials inside a database transaction so a newer login cannot be erased by an older failed request.

## Add a scenario

Use `test_control_with_server` for client behavior and the route harness for behavior in `main.rs`. Use literal protocol JSON so the fake can catch serialization mistakes. Route harness servers abort on drop, including failed assertions.

The reusable browser fixture lives in `e2e/fixtures/sonos.ts`. Pass the same `speakerState()` to multiple simulators to share authoritative state while keeping each browser's requests and fault gates independent. Use separate browser contexts to avoid sharing local storage between controllers.

Separate state changes from responses: `lost-reply` applies pause and returns an error; `rejected` fails before changing state. Deferred gates control response ordering. Held polls return snapshots captured when they arrived. Advance Playwright's clock for browser deadlines rather than sleeping.

Assert request counts, IDs, positions and control availability as well as final state. Keep authorization values out of diagnostics. On failure, the fixture writes and attaches `sonos-transcript.json` under the test's output directory. It includes controller names, ordered commands, the state captured by reads, and which read each delayed reply belongs to. The controller tests also retain Playwright traces on the first failure. Route test failures print an ordered transcript with session/item IDs and requested positions, excluding authorization values.

The reverse-order playback poll test was checked by temporarily removing the ordering guard: it failed at the stale response, as intended. The guard was restored afterward.

## Remaining limits

The media-session tests invoke the registered callbacks while keeping the browser's real Media Session API. They verify command routing, not delivery from physical media keys. Firefox on Linux can withhold global media keys when a tab has no local playback; setting metadata and `playbackState` alone does not activate its native controls. See [Firefox's controller activation rules](https://searchfox.org/firefox-main/source/dom/media/mediacontrol/MediaController.cpp). Check physical keys separately with both a browser-to-Sonos handoff and a fresh tab that starts on Sonos.

These scenarios cover the previously listed follow-ups. They do not model every combination of faults. Useful future incidents to capture include owner changes during an in-flight retry, successful refresh racing with disconnect, and additional mute/volume failures. A missing group never causes automatic selection of a replacement group. The two-controller test asserts eventual convergence, not an arbitrary winner between simultaneous commands.

Turn each new real incident into a reproducible scenario. The stale-session timeout is an observed compatibility case, not a promise about every Sonos device.
