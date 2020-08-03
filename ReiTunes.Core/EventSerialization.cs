using Newtonsoft.Json;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public static class EventSerialization {

        private static JsonSerializerSettings SerializerSettings = new JsonSerializerSettings {
            TypeNameHandling = TypeNameHandling.All,
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

        public static IEvent Deserialize(string value) {
            return JsonConvert.DeserializeObject<IEvent>(value, SerializerSettings);
        }

        public static async Task<IEvent> DeserializeAsync(string value) {
            return await Task.Run(() => {
                return Deserialize(value);
            });
        }

        public static async Task<string> SerializeAsync(IEvent @event) {
            return await Task.Run<string>(() => {
                // Pretty-print for convenience. Revisit this if it ever becomes
                // a perf issue, but for now YAGNI
                return Serialize(@event);
            });
        }
    }
}