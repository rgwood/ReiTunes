using Microsoft.AspNetCore.WebUtilities;
using Serilog;
using System;
using System.Collections.Generic;
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
            var response = await _client.GetAsync("/reitunes/allevents");
            response.EnsureSuccessStatusCode();

            string contents = await response.Content.ReadAsStringAsync();

            var deserialized = await Json.DeserializeAsync<List<string>>(contents);
            return deserialized;
        }

        public async Task<IEnumerable<IEvent>> PullAllEventsAsync() {
            var allSerializedEvents = await PullAllSerializedEventsAsync();
            return await Task.Run(() => allSerializedEvents.Select(e => EventSerialization.Deserialize(e)));
        }

        public async Task PushEventAsync(IEvent @event) {
            await PushEventsAsync(new List<IEvent> { @event });
        }

        public async Task PushEventsAsync(IEnumerable<IEvent> events) {
            var serialized = await EventSerialization.SerializeAsync(events.ToList());
            var content = new StringContent(serialized, Encoding.UTF8, "application/json");

            var putResponse = await _client.PutAsync("/reitunes/saveevents", content);

            putResponse.EnsureSuccessStatusCode();
        }

        public async Task CreateNewLibraryItemAsync(string filePath) {
            var uri = QueryHelpers.AddQueryString("/reitunes/createitem", "filePath", filePath);
            var putResponse = await _client.PutAsync(uri, null);
            putResponse.EnsureSuccessStatusCode();
        }
    }
}