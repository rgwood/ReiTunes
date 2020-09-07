using Dapper;
using Microsoft.Data.Sqlite;
using Serilog;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {
    // I wanted to use Dapper in this but it doesn't work in .NET Native, fucking hell...
    // https://stackoverflow.com/questions/54184301/platformnotsupportedexception-throws-when-using-dapper-with-wp

    public class SQLiteEventRepository : ISerializedEventRepository {
        private readonly SqliteConnection _conn;
        private readonly ILogger _logger;

        public SQLiteEventRepository(SqliteConnection conn, ILogger logger = null) {
            _conn = conn;
            _logger = logger ?? LoggerHelpers.DoNothingLogger();
            if (_conn.State != System.Data.ConnectionState.Open) {
                _conn.Open();
            }

            _conn.CreateEventsTableIfNotExists();
        }

        public bool ContainsEvent(Guid eventId) {
            var count = _conn.Query<long>($"SELECT COUNT() FROM events WHERE Id ='{eventId}';").Single();
            return count == 1;
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return GetAllSerializedEvents().Select(s => EventSerialization.Deserialize(s));
        }

        public IEnumerable<string> GetAllSerializedEvents() {
            return GetSerializedEvents("select Serialized from events;");
        }

        private List<string> GetSerializedEvents(string sql) {
            return _conn.Query<string>(sql).ToList();
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
            var sw = Stopwatch.StartNew();
            foreach (IEvent @event in events) {
                Save(@event);
            }

            _logger.Information("Saving {EventCount} events took {ElapsedMs}", events.Count(), sw.ElapsedMilliseconds);
        }

        public IEnumerable<IEvent> GetAllEventsFromMachine(string machineName) {
            var sw = Stopwatch.StartNew();
            var ret = GetSerializedEvents($"select Serialized from events where MachineName = '{machineName}' COLLATE NOCASE;")
                .Select(s => EventSerialization.Deserialize(s));
            _logger.Information("GetAllEventsFromMachine took {ElapsedMs}", sw.ElapsedMilliseconds);
            return ret;
        }

        public int CountOfAllEvents() {
            string sql = $"SELECT COUNT() FROM events;";
            return _conn.QuerySingle<int>(sql);
        }
    }
}