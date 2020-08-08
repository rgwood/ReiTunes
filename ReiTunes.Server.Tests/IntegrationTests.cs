using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.WebUtilities;
using Newtonsoft.Json;
using ReiTunes.Core;
using ReiTunes.Server.Controllers;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace ReiTunes.Server.Tests {

    public class IntegrationTests : IClassFixture<WebApplicationFactory<InMemoryStartup>> {
        private readonly WebApplicationFactory<InMemoryStartup> _factory;

        public IntegrationTests(WebApplicationFactory<InMemoryStartup> factory) {
            _factory = factory;
        }

        [Fact]
        public async Task CanSaveAndRetrieveSingleEvent() {
            var client = _factory.CreateClient();
            List<string> serialized = await GetAllSerializedEventsAsync(client);

            Assert.Empty(serialized);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            @event.MachineName = "Cornelius";
            await SaveEventAsync(client, @event);

            serialized = await GetAllSerializedEventsAsync(client);

            var deserializedEvent = await EventSerialization.DeserializeAsync(serialized.Single());
            AssertEventsAreEqual(@event, deserializedEvent);
        }

        private static async Task SaveEventAsync(HttpClient client, IEvent @event) {
            var putUri = QueryHelpers.AddQueryString("/events/save", "serializedEvent", EventSerialization.Serialize(@event));

            var putResponse = await client.PutAsync(putUri, null);

            putResponse.EnsureSuccessStatusCode();
        }

        // TODO: should add better equality comparers to the event classes themselves
        private static void AssertEventsAreEqual(IEvent event1, IEvent event2) {
            Assert.Equal(event1.Id, event2.Id);
            Assert.Equal(event1.AggregateId, event2.AggregateId);
            Assert.Equal(event1.CreatedTimeUtc, event2.CreatedTimeUtc);
            Assert.Equal(event1.MachineName, event2.MachineName);
            Assert.Equal(event1.GetType(), event2.GetType());
        }

        private static async Task<List<string>> GetAllSerializedEventsAsync(HttpClient client) {
            var response = await client.GetAsync("/events");
            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            var deserialized = await Json.DeserializeAsync<List<string>>(contents);
            return deserialized;
        }

        [Fact]
        public async Task TestControllerGetWorks() {
            var client = _factory.CreateClient();

            var response = await client.GetAsync("/test");

            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            Assert.Equal("foo", contents);
        }

        [Fact]
        public async Task TestControllerGetWithParamWorks() {
            var client = _factory.CreateClient();

            var response = await client.GetAsync("/test/exclaim?input=foo");

            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            Assert.Equal("foo!", contents);
        }

        [Fact]
        public async Task TestControllerGetEnumerable() {
            var client = _factory.CreateClient();

            var response = await client.GetAsync("/test/enumerable");

            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            var deserialized = JsonConvert.DeserializeObject<List<string>>(contents);

            Assert.Equal(2, deserialized.Count());
            Assert.Equal(TestController.GoodString, deserialized[0]);
            Assert.Equal(TestController.BadString, deserialized[1]);
        }

        [Fact]
        public async Task TestControllerPutOK() {
            var client = _factory.CreateClient();

            var uri = QueryHelpers.AddQueryString("/test/validate", "input", TestController.GoodString);

            var response = await client.PutAsync(uri, null);
            response.EnsureSuccessStatusCode();
        }

        [Fact]
        public async Task TestControllerPutFails() {
            var client = _factory.CreateClient();

            var uri = QueryHelpers.AddQueryString("/test/validate", "input", TestController.BadString);

            var response = await client.PutAsync(uri, null);
            Assert.False(response.IsSuccessStatusCode);
        }
    }
}