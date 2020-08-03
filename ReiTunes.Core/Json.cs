using Newtonsoft.Json;
using System.Threading.Tasks;

namespace ReiTunes.Core {
    public static class Json {
        public static T Deserialize<T>(string value) =>
            JsonConvert.DeserializeObject<T>(value);

        public static string Serialize(object value) {
            // Pretty-print for convenience. Revisit this if it ever becomes
            // a perf issue, but for now YAGNI
            return JsonConvert.SerializeObject(value, Formatting.Indented);
        }

        public static async Task<T> DeserializeAsync<T>(string value) =>
            await Task.Run(() => JsonConvert.DeserializeObject<T>(value));

        public static async Task<string> SerializeAsync(object value) =>
            await Task.Run(() => Serialize(value));
    }
}