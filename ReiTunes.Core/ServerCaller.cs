using Microsoft.AspNetCore.WebUtilities;
using Serilog;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    // There's gotta be a better name for this... but, like, it's a class for calling the server
    public class ServerCaller {
        private readonly HttpClient _client;
        private readonly ILogger _logger;

        public ServerCaller(HttpClient client, ILogger logger) {
            _client = client;
            _logger = logger;
        }

        public async Task<List<string>> PullAllSerializedEventsAsync() {
            var sw = Stopwatch.StartNew();
            var response = await _client.GetAsync("/reitunes/allevents");
            response.EnsureSuccessStatusCode();

            string contents = await response.Content.ReadAsStringAsync();

            var serializedKiloByteCount = UnicodeEncoding.UTF8.GetByteCount(contents) / 1024;

            _logger.Information("Pulled {PayloadSizeKb} kb of serialized events in {ElapsedMs} ms",
                serializedKiloByteCount, sw.ElapsedMilliseconds);

            var deserialized = await Json.DeserializeAsync<List<string>>(contents);
            return deserialized;
        }

        public async Task<IEnumerable<IEvent>> PullAllEventsAsync() {
            var allSerializedEvents = await PullAllSerializedEventsAsync();

            var sw = Stopwatch.StartNew();
            var ret = await Task.Run(() => allSerializedEvents.Select(e => EventSerialization.Deserialize(e)));

            _logger.Information("Deserializing {EventCount} events took {ElapsedMs} ms", ret.Count(), sw.ElapsedMilliseconds);

            return ret;
        }

        public async Task PushEventAsync(IEvent @event) {
            await PushEventsAsync(new List<IEvent> { @event });
        }

        public async Task PushEventsAsync(IEnumerable<IEvent> events) {
            var sw = Stopwatch.StartNew();
            var serialized = await EventSerialization.SerializeAsync(events.ToList());
            var content = new StringContent(serialized, Encoding.UTF8, "application/json");

            var serializedKiloByteCount = UnicodeEncoding.UTF8.GetByteCount(serialized) / 1024;
            _logger.Information("About to push {EventCount} events. Serialized size: {eventsSizeKb} kb", events.Count(), serializedKiloByteCount);

            var putResponse = await _client.PutAsync("/reitunes/saveevents", content);

            _logger.Information("Pushing events took {ElapsedMs} ms", sw.ElapsedMilliseconds);

            putResponse.EnsureSuccessStatusCode();
        }

        public async Task CreateNewLibraryItemAsync(string filePath) {
            var uri = QueryHelpers.AddQueryString("/reitunes/createitem", "filePath", filePath);
            var putResponse = await _client.PutAsync(uri, null);
            putResponse.EnsureSuccessStatusCode();
        }
    }
}