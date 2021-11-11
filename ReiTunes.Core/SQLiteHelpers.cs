using Dapper;
using Microsoft.Data.Sqlite;

namespace ReiTunes.Core
{

    public static class SQLiteHelpers
    {

        public static void CreateEventsTableIfNotExists(this SqliteConnection conn)
        {
            string sql = @"
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

        public static void ExecuteNonQuery(this SqliteConnection conn, string sql)
        {
            conn.Execute(sql);
        }

        public static void InsertEvent(this SqliteConnection conn, IEvent @event)
        {
            string serialized = EventSerialization.Serialize(@event);

            string sql = @"INSERT INTO events(Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
                            VALUES(@Id, @AggregateId, @AggregateType, @CreatedTimeUtc, @MachineName, @Serialized);";

            conn.Execute(sql, new
            {
                Id = @event.Id.ToString(),
                AggregateId = @event.AggregateId.ToString(),
                @event.AggregateType,
                @event.CreatedTimeUtc,
                @event.MachineName,
                Serialized = serialized
            });
        }

        public static SqliteConnection CreateFileDb(string filePath)
        {
            SqliteConnection connection = new SqliteConnection($"Data Source={filePath}");
            connection.Open();
            return connection;
        }

        public static SqliteConnection CreateInMemoryDb()
        {
            SqliteConnection connection = new SqliteConnection("DataSource=:memory:");
            connection.Open();
            return connection;
        }
    }
}