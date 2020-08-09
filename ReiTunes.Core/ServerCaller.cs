using Microsoft.AspNetCore.WebUtilities;
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

        public ServerCaller(HttpClient client) {
            _client = client;
        }

        public async Task<List<string>> GetAllSerializedEventsAsync() {
            var response = await _client.GetAsync("/reitunes/allevents");
            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            var deserialized = await Json.DeserializeAsync<List<string>>(contents);
            return deserialized;
        }

        public async Task<IEnumerable<IEvent>> GetAllEventsAsync() {
            var serialized = await GetAllSerializedEventsAsync();
            //todo: should this be an async enumerable somehow?
            return serialized.Select(e => EventSerialization.Deserialize(e));
        }

        public async Task SaveEventAsync(IEvent @event) {
            var putUri = QueryHelpers.AddQueryString("/reitunes/saveevent", "serializedEvent", EventSerialization.Serialize(@event));

            var putResponse = await _client.PutAsync(putUri, null);

            putResponse.EnsureSuccessStatusCode();
        }

        public async Task CreateNewLibraryItemAsync(string filePath) {
            var uri = QueryHelpers.AddQueryString("/reitunes/createitem", "filePath", filePath);
            var putResponse = await _client.PutAsync(uri, null);
            putResponse.EnsureSuccessStatusCode();
        }
    }
}