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
