using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class InMemoryJsonEventRepository : IEventRepository {

        // Keyed off of aggregate ID
        private Dictionary<Guid, List<string>> _events = new Dictionary<Guid, List<string>>();

        private JsonSerializerSettings serializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.All,
            SerializationBinder = new EventBinder()
        };

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            var serializedEvents = _events[aggregateId];
            var deserialized = serializedEvents.Select(e => JsonConvert.DeserializeObject(e, serializerSettings));
            return deserialized.Cast<IEvent>().Where(e => e.AggregateId == aggregateId);
        }

        public void Save(IEvent @event) {
            var serialized = JsonConvert.SerializeObject(@event, serializerSettings);
            if (_events.ContainsKey(@event.AggregateId)) {
                _events[@event.AggregateId].Add(serialized);
            }
            else {
                _events.Add(@event.AggregateId, new List<string> { serialized });
            }
        }
    }
}