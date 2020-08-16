using System;
using System.Data.SQLite;
using System.IO;

namespace ReiTunes.Core {

    public static class SQLiteHelpers {

        public static void CreateEventsTableIfNotExists(this SQLiteConnection conn) {
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
            conn.ExecuteNonQuery(sql);
        }

        public static void ExecuteNonQuery(this SQLiteConnection conn, string sql) {
            using var cmd = new SQLiteCommand(sql, conn);
            cmd.ExecuteNonQuery();
        }

        public static void InsertEvent(this SQLiteConnection conn, IEvent @event) {
            var serialized = EventSerialization.Serialize(@event);

            var sql = @"INSERT INTO events(Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
                            VALUES(@Id, @AggregateId, @AggregateType, @CreatedTimeUtc, @MachineName, @Serialized);";

            using var cmd = new SQLiteCommand(sql, conn);

            cmd.Parameters.AddWithValue("@Id", @event.Id.ToString());

            cmd.Parameters.AddWithValue("@AggregateId", @event.AggregateId.ToString());
            cmd.Parameters.AddWithValue("@AggregateType", @event.AggregateType);
            cmd.Parameters.AddWithValue("@CreatedTimeUtc", @event.CreatedTimeUtc);
            cmd.Parameters.AddWithValue("@MachineName", @event.MachineName);
            cmd.Parameters.AddWithValue("@Serialized", serialized);

            cmd.ExecuteNonQuery();
        }

        public static SQLiteConnection CreateFileDb(string filePath) {
            if (!File.Exists(filePath)) {
                SQLiteConnection.CreateFile(filePath);
            }

            var connection = new SQLiteConnection($"DataSource={filePath}");
            connection.Open();
            return connection;
        }

        public static SQLiteConnection CreateInMemoryDb() {
            var connection = new SQLiteConnection("DataSource=:memory:");
            connection.Open();
            return connection;
        }
    }
}