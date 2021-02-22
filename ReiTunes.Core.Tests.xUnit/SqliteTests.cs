using Dapper;
using Microsoft.Data.Sqlite;
using System;
using System.Linq;
using Xunit;

namespace ReiTunes.Core.Tests.xUnit {

    public class SqliteTests : IDisposable {
        private readonly SqliteConnection _conn;

        public SqliteTests() {
            _conn = SQLiteHelpers.CreateInMemoryDb();
            _conn.CreateEventsTableIfNotExists();
        }

        public void Dispose() {
            _conn.Dispose();
        }

        [Fact]
        public void CanSaveEvent() {
            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();

            SaveEvent(@event, _conn);
            Assert.Equal(1, GetRowCount("events"));
        }

        [Fact]
        public void CanHookUpEventAutoSave() {
            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();

            SaveEvent(@event, _conn);

            agg.Commit();

            agg.EventCreated += Agg_EventCreated;

            agg.Text = "bar";

            Assert.Empty(agg.GetUncommittedEvents());

            Assert.Equal(2, GetRowCount("events"));
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

        private void SaveEvent(IEvent @event, SqliteConnection connection) {
            connection.InsertEvent(@event);
        }

        private long GetRowCount(string tableName) {
            // can't parameterize table names :(
            return _conn.QuerySingle<long>($"SELECT COUNT() FROM {tableName}");
        }
    }
}