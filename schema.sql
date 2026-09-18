CREATE TABLE IF NOT EXISTS
events(
    Id TEXT PRIMARY KEY NOT NULL,
    AggregateId TEXT NOT NULL,
    AggregateType TEXT NOT NULL,
    CreatedTimeUtc TEXT NOT NULL,
    MachineName TEXT NOT NULL,
    Serialized TEXT NOT NULL
);

-- Sonos OAuth tokens are encrypted before they reach SQLite. This singleton row
-- survives application restarts without putting a refresh token in source or in
-- a browser cookie.
CREATE TABLE IF NOT EXISTS
sonos_oauth_tokens(
    Id INTEGER PRIMARY KEY NOT NULL CHECK (Id = 1),
    Nonce BLOB NOT NULL,
    Ciphertext BLOB NOT NULL,
    AuthenticationTag BLOB NOT NULL
);

-- Cloud Queue callbacks can outlive the ReiTunes process. Keeping the queue
-- snapshot here means a deploy does not turn the URLs already handed to Sonos
-- into 404s part-way through playback.
CREATE TABLE IF NOT EXISTS
sonos_cloud_queues(
    Id TEXT PRIMARY KEY NOT NULL,
    CreatedAtUnix INTEGER NOT NULL,
    Serialized TEXT NOT NULL
);

-- Sonos playback sessions also outlive an individual ReiTunes process. This
-- lets a restarted server keep using the session that owns the active queue.
CREATE TABLE IF NOT EXISTS
sonos_playback_sessions(
    GroupId TEXT PRIMARY KEY NOT NULL,
    SessionId TEXT NOT NULL
);

-- Discovery is a personal feed, separate from the library's event history.
-- Keep dismissed URLs too, so refreshing a source cannot resurrect them.
CREATE TABLE IF NOT EXISTS discovery_state (
    Id INTEGER PRIMARY KEY CHECK (Id = 1),
    Serialized TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_imports (
    SourceId TEXT PRIMARY KEY NOT NULL,
    LibraryItemId TEXT NOT NULL
);

-- Model suggestions are replaceable; human decisions survive reclassification.
CREATE TABLE IF NOT EXISTS tagging_items (
    ItemId TEXT PRIMARY KEY NOT NULL,
    MetadataHash TEXT NOT NULL,
    Status TEXT NOT NULL,
    Serialized TEXT NOT NULL,
    UpdatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tagging_labels (
    ItemId TEXT NOT NULL,
    Tag TEXT NOT NULL,
    Serialized TEXT NOT NULL,
    PRIMARY KEY (ItemId, Tag)
);
-- Exact evidence, prompt and response are retained locally for reproducibility.
CREATE TABLE IF NOT EXISTS tagging_runs (
    Id TEXT PRIMARY KEY NOT NULL,
    ItemId TEXT NOT NULL,
    MetadataHash TEXT NOT NULL,
    StartedAt INTEGER NOT NULL,
    FinishedAt INTEGER,
    Request TEXT NOT NULL,
    Evidence TEXT NOT NULL,
    Response TEXT,
    Error TEXT,
    CostUsd REAL
);
-- A run is a batch agent session; each model request/response has its own trace event.
-- ItemId/MetadataHash on tagging_runs retain the first member for legacy readers.
CREATE TABLE IF NOT EXISTS tagging_run_items (
    RunId TEXT NOT NULL,
    RequestItemId TEXT NOT NULL,
    ItemId TEXT NOT NULL,
    MetadataHash TEXT NOT NULL,
    Status TEXT NOT NULL,
    Error TEXT,
    PRIMARY KEY (RunId, RequestItemId)
);
CREATE TABLE IF NOT EXISTS tagging_agent_events (
    RunId TEXT NOT NULL,
    Sequence INTEGER NOT NULL,
    CreatedAt INTEGER NOT NULL,
    Serialized TEXT NOT NULL,
    PRIMARY KEY (RunId, Sequence)
);
