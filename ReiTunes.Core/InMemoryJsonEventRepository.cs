using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class InMemoryJsonEventRepository : IEventRepository {
        private List<string> _events = new List<string>();

        private JsonSerializerSettings serializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.All,
            SerializationBinder = new EventBinder()
        };

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            var deserialized = _events.Select(e => JsonConvert.DeserializeObject(e, serializerSettings));
            return deserialized.Cast<IEvent>().Where(e => e.AggregateId == aggregateId);
        }

        public void Save(IEvent @event) {
            var serialized = JsonConvert.SerializeObject(@event, serializerSettings);
            _events.Add(serialized);
        }
    }
}