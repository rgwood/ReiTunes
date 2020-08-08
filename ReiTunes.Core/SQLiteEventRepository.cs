using Dapper;
using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class SQLiteEventRepository : ISerializedEventRepository {
        private readonly SQLiteConnection _conn;

        public SQLiteEventRepository(SQLiteConnection conn) {
            _conn = conn;

            if (_conn.State != System.Data.ConnectionState.Open) {
                _conn.Open();
            }

            CreateEventsTableIfNotExists(_conn);
        }

        public bool ContainsEvent(Guid eventId) {
            var count = _conn.QuerySingle<long>($"SELECT COUNT() FROM events WHERE Id ='{eventId}';");
            return count == 1;
        }

        public IEnumerable<IEvent> GetAllEvents() {
            var serializedEvents = _conn.Query<string>("select Serialized from events");

            var deserializedEvents = serializedEvents.Select(s => EventSerialization.Deserialize(s));

            return deserializedEvents.OrderBy(e => e.CreatedTimeUtc);
        }

        public IEnumerable<string> GetAllSerializedEvents() {
            return _conn.Query<string>("select Serialized from events");
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            var serializedEvents =
                _conn.Query<string>($"select Serialized from events WHERE AggregateId = '{aggregateId}'");

            var deserializedEvents = serializedEvents.Select(s => EventSerialization.Deserialize(s));

            return deserializedEvents.OrderBy(e => e.CreatedTimeUtc);
        }

        public void Save(IEvent @event) {
            if (ContainsEvent(@event.Id))
                return;

            var serialized = EventSerialization.Serialize(@event);

            _conn.Execute(@"INSERT INTO events(Id, AggregateId, AggregateType, CreatedTimeUtc, MachineName, Serialized)
                            VALUES(@Id, @AggregateId, @AggregateType, @CreatedTimeUtc, @MachineName, @Serialized);",
                            new {
                                Id = @event.Id.ToString(),
                                AggregateId = @event.AggregateId.ToString(),
                                @event.AggregateType,
                                @event.CreatedTimeUtc,
                                @event.MachineName,
                                Serialized = serialized
                            });
        }

        public void Save(IEnumerable<IEvent> events) {
            foreach (IEvent @event in events) {
                Save(@event);
            }
        }

        private void CreateEventsTableIfNotExists(SQLiteConnection connection) {
            var sql = @"CREATE TABLE IF NOT EXISTS
                        events(
                            Id TEXT PRIMARY KEY NOT NULL,
                            AggregateId TEXT NOT NULL,
                            AggregateType TEXT NOT NULL,
                            CreatedTimeUtc TEXT NOT NULL,
                            MachineName TEXT NOT NULL,
                            Serialized TEXT NOT NULL
                        )";
            connection.Execute(sql);
        }
    }
}