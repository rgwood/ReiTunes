# ReiTunes

Personal music library: a Rust (axum) server with an event-sourced SQLite database, and a React frontend. Music files live in S3-compatible object storage.

## Layout

- `reitunes/` - the web server, Sonos integration, discovery, tagging etc. Most work happens here.
- `reitunes-web/` - React frontend. Its build output (`dist/`) is embedded into the server binary at compile time by vite-rs.
- `src/`, `tests/`, `schema.sql` - the `reitunes-workspace` crate: shared event/library/playlist code.
- `tagging-engine/` - automatic tagging agent and eval tooling.
- `scripts/` - one-off helper scripts.

## Development

Run `just` commands from the `reitunes/` directory, not the repo root.

```bash
cd reitunes
just dev      # Start the dev server on http://localhost:5000 (auth disabled; run it in the background)
just kill     # Stop the dev server
just test     # Rust tests for the reitunes crate (cargo nextest)
```

Only run one dev server at a time. Stop any dev server you started earlier before starting another.

The dev database is `reitunes/reitunes-library.db`. It's gitignored; the server creates the schema on startup.

Frontend tests run from `reitunes-web/` and don't need the Rust server:

```bash
npm test           # Vitest
npm run test:e2e   # Playwright, with the API mocked
npm run build      # Typecheck and production build
```

Use the Chrome DevTools MCP tools (configured in `.mcp.json`) to check frontend changes manually.

## Deploying

`just publish` (from `reitunes/`) builds a musl release binary, copies it to `spudnik` and restarts the systemd service. Agents may run it. `just get-logs 100` shows the production log.

## Secrets

Never print, log or commit secrets. They live in:

- `reitunes/prod.env` - production config, baked into the binary at build time. See `prod.env.example`.
- `reitunes/.env` - dev config, sourced by `just dev`.
- `openrouterkey.txt` - OpenRouter API key for import metadata and tagging.
