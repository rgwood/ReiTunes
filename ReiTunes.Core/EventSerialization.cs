using Newtonsoft.Json;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public static class EventSerialization {

        private static JsonSerializerSettings DefaultSerializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.Objects,
            SerializationBinder = new EventBinder()
        };

        private static JsonSerializerSettings PrettySerializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.Objects,
            SerializationBinder = new EventBinder(),
            Formatting = Formatting.Indented
        };

        /// <summary>
        /// Serializes events with their non-namespaced type name
        /// </summary>
        /// <param name="event"></param>
        /// <returns></returns>
        public static string Serialize(IEvent @event) 
            => JsonConvert.SerializeObject(@event, DefaultSerializerSettings);

        /// <summary>
        /// Serializes events with their non-namespaced type name
        /// </summary>
        /// <param name="event"></param>
        /// <returns></returns>
        public static string PrettyPrint(IEvent @event) 
            => JsonConvert.SerializeObject(@event, PrettySerializerSettings);

        public static string Serialize(List<IEvent> events) 
            => JsonConvert.SerializeObject(events, DefaultSerializerSettings);

        public static IEvent Deserialize(string value) 
            => JsonConvert.DeserializeObject<IEvent>(value, DefaultSerializerSettings);

        public static List<IEvent> DeserializeList(string value) 
            => JsonConvert.DeserializeObject<List<IEvent>>(value, DefaultSerializerSettings);

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