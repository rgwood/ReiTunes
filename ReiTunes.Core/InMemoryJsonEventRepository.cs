using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ReiTunes.Core {

    public class InMemoryJsonEventRepository : IEventRepository {

        // Keyed off of aggregate ID
        private Dictionary<Guid, List<string>> _events = new Dictionary<Guid, List<string>>();

        public bool ContainsEvent(Guid eventId) {
            return GetAllEvents().Any(e => e.Id == eventId);
        }

        public int CountOfAllEvents() => _events.Count();

        //TODO: this is stupid and slow, find a better way
        public IEnumerable<IEvent> GetAllEvents() {
            var serializedEvents = _events.Values.SelectMany(e => e);
            return serializedEvents.Select(e => EventSerialization.Deserialize(e));
        }

        //TODO: this is stupid and slow, find a better way
        public IEnumerable<IEvent> GetAllEventsFromMachine(string machineName) {
            return GetAllEvents().Where(e => e.MachineName.ToUpper() == machineName.ToUpper());
        }

        public IEnumerable<IEvent> GetEvents(Guid aggregateId) {
            var serializedEvents = _events[aggregateId];
            var deserialized = serializedEvents.Select(e => EventSerialization.Deserialize(e));
            return deserialized.Cast<IEvent>();
        }

        public void Save(IEnumerable<IEvent> events) {
            foreach (var @event in events) {
                Save(@event);
            }
        }

        public void Save(IEvent @event) {
            if (ContainsEvent(@event.Id))
                return;

            if (string.IsNullOrEmpty(@event.MachineName)) {
                throw new Exception($"Machine name not specified on event {@event.Id}");
            }

            var serialized = EventSerialization.Serialize(@event);
            if (_events.ContainsKey(@event.AggregateId)) {
                _events[@event.AggregateId].Add(serialized);
            }
            else {
                _events.Add(@event.AggregateId, new List<string> { serialized });
            }
        }
    }
}