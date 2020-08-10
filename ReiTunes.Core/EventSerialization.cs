using Newtonsoft.Json;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public static class EventSerialization {

        private static JsonSerializerSettings SerializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.Objects,
            SerializationBinder = new EventBinder()
        };

        /// <summary>
        /// Serializes events with their non-namespaced type name
        /// </summary>
        /// <param name="event"></param>
        /// <returns></returns>
        public static string Serialize(IEvent @event) {
            return JsonConvert.SerializeObject(@event, SerializerSettings);
        }

        public static string Serialize(List<IEvent> events) {
            return JsonConvert.SerializeObject(events, SerializerSettings);
        }

        public static IEvent Deserialize(string value) {
            return JsonConvert.DeserializeObject<IEvent>(value, SerializerSettings);
        }

        public static List<IEvent> DeserializeList(string value) {
            return JsonConvert.DeserializeObject<List<IEvent>>(value, SerializerSettings);
        }

        public static async Task<List<IEvent>> DeserializeListAsync(string value) {
            return await Task.Run(() => {
                return DeserializeList(value);
            });
        }

        public static async Task<IEvent> DeserializeAsync(string value) {
            return await Task.Run(() => {
                return Deserialize(value);
            });
        }

        public static async Task<string> SerializeAsync(IEvent @event) {
            return await Task.Run(() => Serialize(@event));
        }

        public static async Task<string> SerializeAsync(List<IEvent> events) {
            return await Task.Run(() => Serialize(events));
        }
    }
}