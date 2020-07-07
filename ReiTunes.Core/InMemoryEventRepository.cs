using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class InMemoryEventRepository : IEventRepository {
        private List<IEvent> _events = new List<IEvent>();

        public bool ContainsEvent(Guid eventId) {
            return _events.Any(e => e.Id == eventId);
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return _events;
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            return _events.Where(e => e.AggregateId == aggregateId);
        }

        public void Save(IEvent @event) {
            if (ContainsEvent(@event.Id))
                return;

            _events.Add(@event);
        }
    }
}