﻿using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {
    // I wanted to use Dapper in this but it doesn't work in .NET Native, fucking hell...
    // https://stackoverflow.com/questions/54184301/platformnotsupportedexception-throws-when-using-dapper-with-wp

    public class SQLiteEventRepository : ISerializedEventRepository {
        private readonly SQLiteConnection _conn;

        public SQLiteEventRepository(SQLiteConnection conn) {
            _conn = conn;

            if (_conn.State != System.Data.ConnectionState.Open) {
                _conn.Open();
            }

            _conn.CreateEventsTableIfNotExists();
        }

        public bool ContainsEvent(Guid eventId) {
            string sql = $"SELECT COUNT() FROM events WHERE Id ='{eventId}';";
            var cmd = new SQLiteCommand(sql, _conn);
            using var reader = cmd.ExecuteReader();

            reader.Read();

            var count = reader.GetInt32(0);

            //var count = _conn.Query<long>($"SELECT COUNT() FROM events WHERE Id ='{eventId}';").Single();
            return count == 1;
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return GetAllSerializedEvents().Select(s => EventSerialization.Deserialize(s));
        }

        public IEnumerable<string> GetAllSerializedEvents() {
            return GetSerializedEvents("select Serialized from events;");
        }

        private List<string> GetSerializedEvents(string sql) {
            var cmd = new SQLiteCommand(sql, _conn);
            using var reader = cmd.ExecuteReader();

            var result = new List<string>();

            while (reader.Read()) {
                result.Add(reader.GetString(0));
            }

            return result;
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            var serializedEvents =
                GetSerializedEvents($"select Serialized from events WHERE AggregateId = '{aggregateId}'");

            var deserializedEvents = serializedEvents.Select(s => EventSerialization.Deserialize(s));

            return deserializedEvents.OrderBy(e => e.CreatedTimeUtc);
        }

        public void Save(IEvent @event) {
            if (ContainsEvent(@event.Id))
                return;

            _conn.InsertEvent(@event);
        }

        public void Save(IEnumerable<IEvent> events) {
            foreach (IEvent @event in events) {
                Save(@event);
            }
        }
    }
}