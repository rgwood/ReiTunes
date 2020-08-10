using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
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

    public class IntegrationTests {
        private readonly WebApplicationFactory<Startup> _factory;

        private readonly ServerCaller _serverCaller;

        private readonly LibraryItemEventFactory _serverEventFactory;

        public IntegrationTests() {
            _factory = new WebApplicationFactory<Startup>().WithWebHostBuilder(builder => {
                builder.ConfigureTestServices(services => {
                    services.AddSingleton<ISerializedEventRepository, SQLiteEventRepository>(
                        _ => new SQLiteEventRepository(SQLiteHelpers.CreateInMemoryDb()));
                });
            });

            _serverCaller = new ServerCaller(_factory.CreateClient());
            _serverEventFactory = new LibraryItemEventFactory("Server");
        }

        [Fact]
        public async Task CanSaveAndRetrieveSingleEvent() {
            List<string> serialized = await _serverCaller.PullAllSerializedEventsAsync();

            Assert.Empty(serialized);

            var agg = new SimpleTextAggregate("foo");
            var @event = agg.GetUncommittedEvents().Single();
            await _serverCaller.PushEventAsync(@event);

            serialized = await _serverCaller.PullAllSerializedEventsAsync();

            var deserializedEvent = await EventSerialization.DeserializeAsync(serialized.Single());
            AssertEventsAreEqual(@event, deserializedEvent);
        }

        /// <summary>
        /// A large test designed to exercise saving+retrieving events from multiple clients
        /// </summary>
        /// <returns></returns>
        [Fact]
        public async Task MainIntegrationTest() {
            var l1 = new Library("machine1", SQLiteHelpers.CreateInMemoryDb(), _serverCaller);
            var l2 = new Library("machine2", SQLiteHelpers.CreateInMemoryDb(), _serverCaller);

            await _serverCaller.CreateNewLibraryItemAsync("foo/bar.mp3");

            await l1.PullFromServer();

            var item = l1.Items.Single();
            item.IncrementPlayCount();
            item.IncrementPlayCount();
            item.Name = "GIMIX set";
            item.FilePath = "bar.mp3";
            item.Artist = "The Avalanches";
            item.Album = "Mixes";

            await l1.PushToServer();
            await l2.PullFromServer();

            LibrariesHaveSameItems(l1, l2);

            l2.Items.Single().IncrementPlayCount();

            await l2.PushToServer();
            await l1.PullFromServer();

            LibrariesHaveSameItems(l1, l2);
        }

        private void LibrariesHaveSameItems(Library l1, Library l2) {
            Assert.Equal(l1.Items.Count, l2.Items.Count);

            var orderedModels1 = l1.Items.OrderBy(m => m.AggregateId).ToArray();
            var orderedModels2 = l2.Items.OrderBy(m => m.AggregateId).ToArray();

            for (int i = 0; i < orderedModels1.Count(); i++) {
                Assert.Equal(orderedModels1[i], orderedModels2[i]);
            }
        }

        // TODO: should add better equality comparers to the event classes themselves
        private static void AssertEventsAreEqual(IEvent event1, IEvent event2) {
            Assert.Equal(event1.Id, event2.Id);
            Assert.Equal(event1.AggregateId, event2.AggregateId);
            Assert.Equal(event1.CreatedTimeUtc, event2.CreatedTimeUtc);
            Assert.Equal(event1.MachineName, event2.MachineName);
            Assert.Equal(event1.GetType(), event2.GetType());
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