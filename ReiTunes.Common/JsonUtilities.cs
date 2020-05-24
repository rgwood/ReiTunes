using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Text;

namespace ReiTunes.Common
{
    public class JsonUtilities
    {

        public static string Serialize(IEnumerable<ExplorerItem> items)
        {
            // Pretty-print for convenience. Revisit this if it ever becomes
            // a perf issue, but for now YAGNI
            return JsonConvert.SerializeObject(items, Formatting.Indented);
        }

        public static IEnumerable<ExplorerItem> Deserialize(string json)
        {
            return JsonConvert.DeserializeObject<List<ExplorerItem>>(json);
        }
    }
}
