using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class InMemoryEventRepository : IEventRepository {
        private List<IEvent> _events = new List<IEvent>();

        public IEnumerable<IEvent> GetEvents(Guid id) {
            return _events.Where(e => e.Id == id);
        }

        public void Save(IEvent @event) {
            _events.Add(@event);
        }
    }
}