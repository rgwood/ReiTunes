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
