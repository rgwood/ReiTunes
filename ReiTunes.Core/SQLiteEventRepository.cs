using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Text;

namespace ReiTunes.Core {

    public class SQLiteEventRepository : IEventRepository {
        private readonly SQLiteConnection _conn;

        public SQLiteEventRepository(SQLiteConnection conn) {
            this._conn = conn;
        }

        public bool ContainsEvent(Guid eventId) {
            throw new NotImplementedException();
        }

        public IEnumerable<IEvent> GetAllEvents() {
            throw new NotImplementedException();
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            throw new NotImplementedException();
        }

        public void Save(IEvent @event) {
            throw new NotImplementedException();
        }

        public void Save(IEnumerable<IEvent> events) {
            throw new NotImplementedException();
        }
    }
}