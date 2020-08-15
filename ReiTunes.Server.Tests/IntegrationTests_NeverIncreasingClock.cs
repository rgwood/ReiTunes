using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;
using ReiTunes.Core;
using ReiTunes.Server.Controllers;
using Serilog.Core;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using Xunit.Sdk;

namespace ReiTunes.Server.Tests {

    public class IntegrationTests_NeverIncreasingClock {
        private readonly WebApplicationFactory<Startup> _factory;

        private readonly ServerCaller _serverCaller;

        public IntegrationTests_NeverIncreasingClock() {
            _factory = new WebApplicationFactory<Startup>().WithWebHostBuilder(builder => {
                builder.ConfigureTestServices(services => {
                    services.AddSingleton<ISerializedEventRepository, SQLiteEventRepository>(
                        _ => new SQLiteEventRepository(SQLiteHelpers.CreateInMemoryDb()));
                    services.AddTransient<IClock, NeverIncreasingClock>();
                });
            });

            _serverCaller = new ServerCaller(_factory.CreateClient());
        }

        [Fact]
        public async Task Integration_BasicItemSync() {
            var clock = new NeverIncreasingClock();
            var client1 = new Library("machine1", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None, clock);
            var client2 = new Library("machine2", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None, clock);

            // create item on server, pull to 1
            await _serverCaller.CreateNewLibraryItemAsync("foo/bar.mp3");
            await client1.PullFromServer();

            // modify item to generate a bunch of events with the same time but increasing ID
            var item = client1.Items.Single();
            item.IncrementPlayCount();
            item.IncrementPlayCount();
            item.Name = "foo";
            item.Name = "foo";
            item.Name = "foo";
            item.Name = "foo";
            item.Name = "bar";

            // sync from 1 to 2
            await client1.PushToServer();
            await client2.PullFromServer();

            AssertLibrariesHaveSameItems(client1, client2);
        }

        private void AssertLibrariesHaveSameItems(Library l1, Library l2) {
            Assert.Equal(l1.Items.Count, l2.Items.Count);

            var orderedModels1 = l1.Items.OrderBy(m => m.AggregateId).ToArray();
            var orderedModels2 = l2.Items.OrderBy(m => m.AggregateId).ToArray();

            for (int i = 0; i < orderedModels1.Count(); i++) {
                Assert.Equal(orderedModels1[i], orderedModels2[i]);
            }
        }
    }
}