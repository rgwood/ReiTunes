using System;
using System.Threading.Tasks;

using Newtonsoft.Json;

namespace ReiTunes.Core.Helpers
{
    public static class Json
    {
        public static async Task<T> ToObjectAsync<T>(string value)
        {
            return await Task.Run<T>(() =>
            {
                return JsonConvert.DeserializeObject<T>(value);
            });
        }

        public static async Task<string> StringifyAsync(object value)
        {
            return await Task.Run<string>(() =>
            {
                // Pretty-print for convenience. Revisit this if it ever becomes
                // a perf issue, but for now YAGNI
                return JsonConvert.SerializeObject(value, Formatting.Indented);
            });
        }
    }
}
