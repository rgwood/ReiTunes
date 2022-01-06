using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using ReiTunes.Core;
using Serilog;
using Serilog.Core;
using Xunit;

namespace ReiTunes.Server.Tests;

public class IntegrationTests_AlwaysIncreasingClock
{
    private readonly WebApplicationFactory<Program> _factory;

    private readonly ServiceProvider _serviceProvider;
    private readonly ServerCaller _serverCaller;

    public IntegrationTests_AlwaysIncreasingClock()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton<ISerializedEventRepository, SQLiteEventRepository>(
                    _ => new SQLiteEventRepository(SQLiteHelpers.CreateInMemoryDb()));
                services.AddTransient<IClock, AlwaysIncreasingClock>();
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
        Library client1 = new Library("machine1", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None, new AlwaysIncreasingClock());
        Library client2 = new Library("machine2", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None, new AlwaysIncreasingClock());

        // create item on server, pull to 1
        await _serverCaller.CreateNewLibraryItemAsync("foo/bar.mp3");
        await client1.PullFromServer();

        // modify item to generate a bunch of events with the same time but increasing ID
        LibraryItem itemOn1 = client1.Items.Single();
        itemOn1.IncrementPlayCount();
        itemOn1.IncrementPlayCount();
        itemOn1.Name = "bar";

        // sync from 1 to 2
        await client1.PushToServer();
        await client2.PullFromServer();

        AssertLibrariesHaveSameItems(client1, client2);

        LibraryItem itemOn2 = client2.Items.Single();

        itemOn1.Name = "1";
        itemOn2.Name = "2";

        await client2.PushToServer();
        await client1.PushToServer();
        await client1.PullFromServer();

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
