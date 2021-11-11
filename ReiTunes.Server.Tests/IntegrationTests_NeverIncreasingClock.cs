using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using ReiTunes.Core;
using Serilog;
using Serilog.Core;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Xunit;

namespace ReiTunes.Server.Tests;

public class IntegrationTests_NeverIncreasingClock
{
    private readonly WebApplicationFactory<Startup> _factory;

    private readonly ServiceProvider _serviceProvider;

    private readonly ServerCaller _serverCaller;

    public IntegrationTests_NeverIncreasingClock()
    {
        _factory = new WebApplicationFactory<Startup>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton<ISerializedEventRepository, SQLiteEventRepository>(
                    _ => new SQLiteEventRepository(SQLiteHelpers.CreateInMemoryDb()));
                services.AddTransient<IClock, NeverIncreasingClock>();
            });
        });

        ServiceCollection services = new ServiceCollection();

        services.AddSingleton<HttpClient>((_) => _factory.CreateClient());
        services.AddSingleton<ILogger>((_) => Logger.None);
        services.AddSingleton<ServerCaller>();

        _serviceProvider = services.BuildServiceProvider();

        _serverCaller = _serviceProvider.GetService<ServerCaller>();
    }

    [Fact]
    public async Task Integration_BasicItemSync()
    {
        NeverIncreasingClock clock = new NeverIncreasingClock();
        Library client1 = new Library("machine1", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None, clock);
        Library client2 = new Library("machine2", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None, clock);

        // create item on server, pull to 1
        await _serverCaller.CreateNewLibraryItemAsync("foo/bar.mp3");
        await client1.PullFromServer();

        // modify item to generate a bunch of events with the same time but increasing ID
        LibraryItem item = client1.Items.Single();
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

    private static void AssertLibrariesHaveSameItems(Library l1, Library l2)
    {
        Assert.Equal(l1.Items.Count, l2.Items.Count);

        LibraryItem[] orderedModels1 = l1.Items.OrderBy(m => m.AggregateId).ToArray();
        LibraryItem[] orderedModels2 = l2.Items.OrderBy(m => m.AggregateId).ToArray();

        for (int i = 0; i < orderedModels1.Count(); i++)
        {
            Assert.Equal(orderedModels1[i], orderedModels2[i]);
        }
    }
}
