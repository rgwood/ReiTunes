using Microsoft.Data.Sqlite;
using System;
using System.IO;
using Dapper;

namespace ReiTunes.Core {

    public static class SQLiteHelpers {

        public static void CreateEventsTableIfNotExists(this SqliteConnection conn) {
            var sql = @"
CREATE TABLE IF NOT EXISTS
events(
    Id TEXT PRIMARY KEY NOT NULL,
    AggregateId TEXT NOT NULL,
    AggregateType TEXT NOT NULL,
    CreatedTimeUtc TEXT NOT NULL,
    MachineName TEXT NOT NULL,
    Serialized TEXT NOT NULL
)";
            conn.Execute(sql);
        }

        public static void ExecuteNonQuery(this SqliteConnection conn, string sql) {
            conn.Execute(sql);
        }

        public static void InsertEvent(this SqliteConnection conn, IEvent @event) {
            var serialized = EventSerialization.Serialize(@event);

            var sql = @"INSERT INTO events(Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
                            VALUES(@Id, @AggregateId, @AggregateType, @CreatedTimeUtc, @MachineName, @Serialized);";

            conn.Execute(sql, new { Id = @event.Id.ToString(),
               AggregateId = @event.AggregateId.ToString(),
                @event.AggregateType,
                @event.CreatedTimeUtc,
                @event.MachineName,
                Serialized = serialized
            });
        }

        public static SqliteConnection CreateFileDb(string filePath) {
            var connection = new SqliteConnection($"Data Source={filePath}");
            connection.Open();
            return connection;
        }

        public static SqliteConnection CreateInMemoryDb() {
            var connection = new SqliteConnection("DataSource=:memory:");
            connection.Open();
            return connection;
        }
    }
}