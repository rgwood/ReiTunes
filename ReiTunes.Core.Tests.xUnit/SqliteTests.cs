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
            _conn.CreateEventsTableIfNotExists();
        }

        public void Dispose() {
            _conn.Dispose();
        }

        [Fact]
        public void CanCreateEmptyTableAndInsert() {
            _conn.Execute(@"CREATE TABLE IF NOT EXISTS priceData(id INTEGER PRIMARY KEY, secId TEXT)");

            Assert.Equal(0, _conn.GetRowCount("priceData"));

            _conn.Execute(@"INSERT INTO priceData(id, secId) VALUES(1,'MSFT');");

            Assert.Equal(1, _conn.GetRowCount("priceData"));
        }

        [Fact]
        public void CanSaveEvent() {
            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, _conn);
            Assert.Equal(1, _conn.GetRowCount("events"));
        }

        [Fact]
        public void CanHookUpEventAutoSave() {
            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = MachineName;

            SaveEvent(@event, _conn);

            agg.Commit();

            agg.EventCreated += Agg_EventCreated;

            agg.Text = "bar";

            Assert.Empty(agg.GetUncommittedEvents());

            Assert.Equal(2, _conn.GetRowCount("events"));
        }

        private void Agg_EventCreated(object sender, IEvent e) {
            SaveEvent(e, _conn);
            var agg = (Aggregate)sender;
            agg.Commit();
        }

        [Fact]
        public void SQLiteEnforcesNoSavingDuplicates() {
            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();

            SaveEvent(@event, _conn);

            Assert.ThrowsAny<Exception>(() => SaveEvent(@event, _conn));
        }

        [Fact]
        public void CanSaveAndReadEvent() {
            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();

            SaveEvent(@event, _conn);

            var serialized = _conn.QuerySingle<string>("select Serialized from events limit 1");

            var deserialized = (SimpleTextAggregateCreatedEvent)EventSerialization.Deserialize(serialized);

            Assert.Equal(agg.AggregateId, deserialized.AggregateId);
            Assert.Equal(agg.CreatedTimeUtc, deserialized.CreatedTimeUtc);
            Assert.Equal(DateTimeKind.Utc, deserialized.CreatedTimeUtc.Kind);
            Assert.Equal(agg.Text, deserialized.Text);
        }

        private void SaveEvent(IEvent @event, SQLiteConnection connection) {
            @event.MachineName = MachineName;
            var serialized = EventSerialization.Serialize(@event);

            connection.Execute(@"
INSERT INTO events(Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
VALUES(@Id, @AggregateId, 'simple',  @CreatedTimeUtc, @MachineName, @Serialized);",
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