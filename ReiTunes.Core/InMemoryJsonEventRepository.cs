using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class InMemoryJsonEventRepository : IEventRepository {

        // Keyed off of aggregate ID
        private Dictionary<Guid, List<string>> _events = new Dictionary<Guid, List<string>>();

        private static JsonSerializerSettings serializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.All,
            SerializationBinder = new EventBinder()
        };

        public static string Serialize(IEvent @event) {
            return JsonConvert.SerializeObject(@event, serializerSettings);
        }

        public bool ContainsEvent(Guid eventId) {
            return GetAllEvents().Any(e => e.Id == eventId);
        }

        //TODO: this is stupid and slow, find a better way
        public IEnumerable<IEvent> GetAllEvents() {
            var serializedEvents = _events.Values.SelectMany(e => e);
            var deserialized = serializedEvents.Select(e => JsonConvert.DeserializeObject(e, serializerSettings));
            return deserialized.Cast<IEvent>();
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            var serializedEvents = _events[aggregateId];
            var deserialized = serializedEvents.Select(e => JsonConvert.DeserializeObject(e, serializerSettings));
            return deserialized.Cast<IEvent>();
        }

        public void Save(IEvent @event) {
            if (ContainsEvent(@event.Id))
                return;

            if (string.IsNullOrEmpty(@event.MachineName)) {
                throw new Exception($"Machine name not specified on event {@event.Id}");
            }

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