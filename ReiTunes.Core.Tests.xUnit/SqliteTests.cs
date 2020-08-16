using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Diagnostics.Contracts;
using System.Linq;
using System.Text;
using Xunit;

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

        private void SaveEvent(IEvent @event, SQLiteConnection connection) {
            connection.InsertEvent(@event);
        }

        private long GetRowCount(string tableName) {
            // can't parameterize table names :(
            using var cmd = new SQLiteCommand($"SELECT COUNT() FROM {tableName}", _conn);

            cmd.Parameters.AddWithValue("@tableName", tableName);

            using var reader = cmd.ExecuteReader();

            reader.Read();

            return reader.GetInt64(0);
        }
    }
}