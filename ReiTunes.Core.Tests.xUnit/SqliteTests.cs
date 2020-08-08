using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Diagnostics.Contracts;
using System.Linq;
using System.Text;
using Xunit;
using Dapper;

namespace ReiTunes.Core.Tests.xUnit {

    public class SqliteTests : IDisposable {
        private const string MachineName = "Cornelius";
        private const string EventTableName = "events";

        private SQLiteConnection _conn;

        public SqliteTests() {
            _conn = CreateInMemoryDb();
            CreateEventsTableIfNotExists(_conn);
        }

        public void Dispose() {
            _conn.Dispose();
        }

        private SQLiteConnection CreateInMemoryDb() {
            var connection = new SQLiteConnection("DataSource=:memory:");
            connection.Open();
            return connection;
        }

        private void CreateEventsTableIfNotExists(SQLiteConnection connection) {
            var sql = @"
CREATE TABLE IF NOT EXISTS
events(
    Id TEXT PRIMARY KEY NOT NULL,
    AggregateId TEXT NOT NULL,
    CreatedTimeUtc TEXT NOT NULL,
    MachineName TEXT NOT NULL,
    Serialized TEXT NOT NULL
)";

            connection.Execute(sql);
        }

        [Fact]
        public void CanCreateEmptyTableAndInsert() {
            var conn = CreateInMemoryDb();

            conn.Execute(@"CREATE TABLE IF NOT EXISTS priceData(id INTEGER PRIMARY KEY, secId TEXT)");

            Assert.Equal(0, conn.GetRowCount("priceData"));

            conn.Execute(@"INSERT INTO priceData(id, secId) VALUES(1,'MSFT');");

            Assert.Equal(1, conn.GetRowCount("priceData"));
        }

        [Fact]
        public void CanCreateEventTableAndInsert() {
            Assert.Equal(0, _conn.GetRowCount(EventTableName));

            _conn.Execute(@"
INSERT INTO events(Id, AggregateId, CreatedTimeUtc, MachineName, Serialized)
VALUES(1,'MSFT','foo','bar','baz');");
            Assert.Equal(1, _conn.GetRowCount("events"));
        }

        [Fact]
        public void CanSaveEvent() {
            var connection = CreateInMemoryDb();
            CreateEventsTableIfNotExists(connection);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, connection);
        }

        [Fact]
        public void SQLiteEnforcesNoSavingDuplicates() {
            var connection = CreateInMemoryDb();
            CreateEventsTableIfNotExists(connection);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, connection);

            Assert.ThrowsAny<Exception>(() => SaveEvent(@event, connection));
        }

        [Fact]
        public void CanSaveAndReadEvent() {
            var connection = CreateInMemoryDb();
            CreateEventsTableIfNotExists(connection);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, connection);

            var time = connection.QuerySingle<string>("select CreatedTimeUtc from events limit 1");

            var serialized = connection.QuerySingle<string>("select Serialized from events limit 1");

            var deserialized = (SimpleTextAggregateCreatedEvent)EventSerialization.Deserialize(serialized);

            Assert.Equal(agg.AggregateId, deserialized.AggregateId);
            Assert.Equal(agg.CreatedTimeUtc, deserialized.CreatedTimeUtc);
            Assert.Equal(DateTimeKind.Utc, deserialized.CreatedTimeUtc.Kind);
            Assert.Equal(agg.Text, deserialized.Text);
        }

        private void SaveEvent(IEvent @event, SQLiteConnection connection) {
            var serialized = EventSerialization.Serialize(@event);

            connection.Execute(@"
INSERT INTO events(Id, AggregateId, CreatedTimeUtc, MachineName, Serialized)
VALUES(@Id, @AggregateId, @CreatedTimeUtc, @MachineName, @Serialized);",
new {
    @event.Id,
    @event.AggregateId,
    @event.CreatedTimeUtc,
    @event.MachineName,
    Serialized = serialized
});
        }
    }
}