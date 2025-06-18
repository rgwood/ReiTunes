CREATE TABLE IF NOT EXISTS
events(
    Id TEXT PRIMARY KEY NOT NULL,
    AggregateId TEXT NOT NULL,
    AggregateType TEXT NOT NULL,
    CreatedTimeUtc TEXT NOT NULL,
    MachineName TEXT NOT NULL,
    Serialized TEXT NOT NULL
)