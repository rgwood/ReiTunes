using Dapper;
using Microsoft.Data.Sqlite;
using Serilog;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace ReiTunes.Core {
    // Because we use Dapper we can't build for .NET Native, fucking hell...
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
            long count = _conn.QuerySingle<long>("SELECT COUNT() FROM events WHERE Id = @EventId", new { EventId = eventId.ToString() });
            return count == 1;
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return GetAllSerializedEvents().Select(s => EventSerialization.Deserialize(s));
        }

        public IEnumerable<string> GetAllSerializedEvents() {
            return GetSerializedEvents("select Serialized from events;");
        }

        private List<string> GetSerializedEvents(string sql, object param = null) {
            return _conn.Query<string>(sql, param).ToList();
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            List<string> serializedEvents =
                GetSerializedEvents("select Serialized from events WHERE AggregateId = @AggregateId", new { AggregateId = aggregateId.ToString() });

            IEnumerable<IEvent> deserializedEvents = serializedEvents.Select(s => EventSerialization.Deserialize(s));

            return deserializedEvents.OrderBy(e => e.CreatedTimeUtc);
        }

        public void Save(IEvent @event) {
            if (ContainsEvent(@event.Id))
                return;

            _conn.InsertEvent(@event);
        }

        public void Save(IEnumerable<IEvent> events) {
            Stopwatch sw = Stopwatch.StartNew();
            foreach (IEvent @event in events) {
                Save(@event);
            }

            _logger.Information("Saving {EventCount} events took {ElapsedMs}", events.Count(), sw.ElapsedMilliseconds);
        }

        public IEnumerable<IEvent> GetAllEventsFromMachine(string machineName) {
            Stopwatch sw = Stopwatch.StartNew();
            IEnumerable<IEvent> ret = GetSerializedEvents("select Serialized from events where MachineName = @MachineName COLLATE NOCASE;", new { MachineName = machineName })
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