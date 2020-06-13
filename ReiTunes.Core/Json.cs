using Newtonsoft.Json;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public static class Json {

        public static T ToObject<T>(string value) {
            return JsonConvert.DeserializeObject<T>(value);
        }

        public static string Stringify(object value) {
            // Pretty-print for convenience. Revisit this if it ever becomes
            // a perf issue, but for now YAGNI
            return JsonConvert.SerializeObject(value, Formatting.Indented);
        }

        public static async Task<T> ToObjectAsync<T>(string value) {
            return await Task.Run<T>(() => {
                return JsonConvert.DeserializeObject<T>(value);
            });
        }

        public static async Task<string> StringifyAsync(object value) {
            return await Task.Run<string>(() => {
                // Pretty-print for convenience. Revisit this if it ever becomes
                // a perf issue, but for now YAGNI
                return JsonConvert.SerializeObject(value, Formatting.Indented);
            });
        }
    }
}