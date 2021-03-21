using Microsoft.AspNetCore.WebUtilities;
using Serilog;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    // There's gotta be a better name for this... but, like, it's a class for calling the server
    public class ServerCaller {
        private const int EventPushBatchSize = 1000; // totally arbitrary limit on the # of events to push at once. Not even sure if we need this, but it makes me feel better
        private readonly HttpClient _client;
        private readonly ILogger _logger;

        public ServerCaller(HttpClient client, ILogger logger) {
            _client = client;
            _logger = logger;
        }

        public async Task<List<string>> PullAllSerializedEventsAsync() {
            Stopwatch sw = Stopwatch.StartNew();
            HttpResponseMessage response = await _client.GetAsync(Secrets.ServerUrl + "/reitunes/allevents");
            response.EnsureSuccessStatusCode();

            string contents = await response.Content.ReadAsStringAsync();

            int serializedKiloByteCount = UnicodeEncoding.UTF8.GetByteCount(contents) / 1024;

            _logger.Information("Pulled {PayloadSizeKb} kb of serialized events in {ElapsedMs} ms",
                serializedKiloByteCount, sw.ElapsedMilliseconds);

            List<string> deserialized = await Json.DeserializeAsync<List<string>>(contents);
            return deserialized;
        }

        public async Task<IEnumerable<IEvent>> PullAllEventsAsync() {
            List<string> allSerializedEvents = await PullAllSerializedEventsAsync();

            Stopwatch sw = Stopwatch.StartNew();
            IEnumerable<IEvent> ret = await Task.Run(() => allSerializedEvents.Select(e => EventSerialization.Deserialize(e)));

            _logger.Information("Deserializing {EventCount} events took {ElapsedMs} ms", ret.Count(), sw.ElapsedMilliseconds);

            return ret;
        }

        public async Task PushEventAsync(IEvent @event) => await PushEventsAsync(new List<IEvent> { @event });

        public async Task PushEventsAsync(IEnumerable<IEvent> events) {
            Stopwatch sw = Stopwatch.StartNew();

            foreach (IEnumerable<IEvent> chunk in events.Chunk(EventPushBatchSize)) {
                string serialized = await EventSerialization.SerializeAsync(chunk.ToList());
                StringContent content = new StringContent(serialized, Encoding.UTF8, "application/json");

                int serializedKiloByteCount = UnicodeEncoding.UTF8.GetByteCount(serialized) / 1024;
                _logger.Information("About to push {EventCount} events. Serialized size: {eventsSizeKb} kb", events.Count(), serializedKiloByteCount);

                HttpResponseMessage putResponse = await _client.PutAsync(Secrets.ServerUrl + "/reitunes/saveevents", content);

                putResponse.EnsureSuccessStatusCode();
            }

            _logger.Information("Pushing all events took {ElapsedMs} ms", sw.ElapsedMilliseconds);
        }

        public async Task CreateNewLibraryItemAsync(string filePath) {
            string uri = QueryHelpers.AddQueryString("/reitunes/createitem", "filePath", filePath);
            HttpResponseMessage putResponse = await _client.PutAsync(Secrets.ServerUrl + uri, null);
            putResponse.EnsureSuccessStatusCode();
        }
    }
}