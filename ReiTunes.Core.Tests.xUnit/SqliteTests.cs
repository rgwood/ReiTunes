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
            _conn = SQLiteHelpers.CreateInMemoryDb();
            CreateEventsTableIfNotExists(_conn);
        }

        public void Dispose() {
            _conn.Dispose();
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
            _conn.Execute(@"CREATE TABLE IF NOT EXISTS priceData(id INTEGER PRIMARY KEY, secId TEXT)");

            Assert.Equal(0, _conn.GetRowCount("priceData"));

            _conn.Execute(@"INSERT INTO priceData(id, secId) VALUES(1,'MSFT');");

            Assert.Equal(1, _conn.GetRowCount("priceData"));
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
            CreateEventsTableIfNotExists(_conn);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, _conn);
        }

        [Fact]
        public void SQLiteEnforcesNoSavingDuplicates() {
            CreateEventsTableIfNotExists(_conn);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, _conn);

            Assert.ThrowsAny<Exception>(() => SaveEvent(@event, _conn));
        }

        [Fact]
        public void CanSaveAndReadEvent() {
            CreateEventsTableIfNotExists(_conn);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, _conn);

            var serialized = _conn.QuerySingle<string>("select Serialized from events limit 1");

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