using Dapper;
using System.Data.SQLite;

namespace ReiTunes.Core {

    public static class SQLiteHelpers {

        public static long GetRowCount(this SQLiteConnection conn, string tableName) {
            return conn.QuerySingle<long>($"SELECT COUNT() FROM {tableName}");
        }

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

            conn.Execute(sql);
        }

        public static SQLiteConnection CreateFileDb(string filePath) {
            SQLiteConnection.CreateFile(filePath);
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