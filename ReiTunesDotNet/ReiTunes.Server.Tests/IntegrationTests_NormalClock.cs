﻿using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;
using ReiTunes.Core;
using ReiTunes.Server.Controllers;
using Serilog;
using Serilog.Core;
using Xunit;

namespace ReiTunes.Server.Tests;

public class IntegrationTests_NormalClock
{
    private readonly WebApplicationFactory<Program> _factory;

    private readonly ServiceProvider _serviceProvider;

    private readonly ServerCaller _serverCaller;

    public IntegrationTests_NormalClock()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.ConfigureTestServices(services =>
            {
                services.AddSingleton<ISerializedEventRepository, SQLiteEventRepository>(
                    _ => new SQLiteEventRepository(SQLiteHelpers.CreateInMemoryDb()));
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
    public async Task CanSaveAndRetrieveSingleEvent()
    {
        List<string> serialized = await _serverCaller.PullAllSerializedEventsAsync();

        Assert.Empty(serialized);

        SimpleTextAggregate agg = new SimpleTextAggregate("foo");
        IEvent @event = agg.GetUncommittedEvents().Single();
        await _serverCaller.PushEventAsync(@event);

        serialized = await _serverCaller.PullAllSerializedEventsAsync();

        IEvent deserializedEvent = await EventSerialization.DeserializeAsync(serialized.Single());
        AssertEventsAreEqual(@event, deserializedEvent);
    }

    /// <summary>
    /// A full-system integration test that exercises saving+retrieving common events
    /// with 1 server and multiple clients
    /// </summary>
    [Fact]
    public async Task Integration_BasicItemSync()
    {
        Library client1 = new Library("machine1", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None);
        Library client2 = new Library("machine2", SQLiteHelpers.CreateInMemoryDb(), _serverCaller, Logger.None);

        // create item on server, pull to 1
        await _serverCaller.CreateNewLibraryItemAsync("foo/bar.mp3");
        await client1.PullFromServer();

        // modify item to generate a bunch of events
        LibraryItem item = client1.Items.Single();
        item.IncrementPlayCount();
        item.IncrementPlayCount();
        item.Name = "GIMIX set";
        item.FilePath = "bar.mp3";
        item.Artist = "The Avalanches";
        item.Album = "Mixes";
        item.AddBookmark(TimeSpan.FromSeconds(30));
        item.AddBookmark(TimeSpan.FromSeconds(40));

        // sync from 1 to 2
        await client1.PushToServer();
        await client2.PullFromServer();

        AssertLibrariesHaveSameItems(client1, client2);

        // Delete a bookmark
        client2.Items.Single().Bookmarks.Count.Should().Be(2);
        client2.Items.Single().DeleteBookmark(item.Bookmarks.First().ID);
        client2.Items.Single().Bookmarks.Count.Should().Be(1);

        // Set bookmark emoji
        LibraryItem client2Item = client2.Items.Single();
        Bookmark remainingBookmark = client2Item.Bookmarks.Single();
        client2.Items.Single().SetBookmarkEmoji(remainingBookmark.ID, "🎶");
        client2.Items.Single().Bookmarks.Single().Emoji.Should().Be("🎶");

        client2.Items.Single().IncrementPlayCount();

        await client2.PushToServer();
        await client1.PullFromServer();

        AssertLibrariesHaveSameItems(client1, client2);

        // delete and make sure the delete propagates
        client1.Delete(client1.Items.Single());

        client1.Items.Count().Should().Be(0);

        await client1.PushToServer();
        await client2.PullFromServer();

        AssertLibrariesHaveSameItems(client1, client2);
    }

    private static void AssertLibrariesHaveSameItems(Library l1, Library l2)
    {
        Assert.Equal(l1.Items.Count(), l2.Items.Count());

        LibraryItem[] orderedModels1 = l1.Items.OrderBy(m => m.AggregateId).ToArray();
        LibraryItem[] orderedModels2 = l2.Items.OrderBy(m => m.AggregateId).ToArray();

        for (int i = 0; i < orderedModels1.Count(); i++)
        {
            AssertItemsAreEqual(orderedModels1[i], orderedModels2[i]);
        }
    }

    private static void AssertItemsAreEqual(LibraryItem item1, LibraryItem item2)
    {
        item1.AggregateId.Should().Be(item2.AggregateId);
        item1.CreatedTimeUtc.Should().Be(item2.CreatedTimeUtc);
        item1.Name.Should().Be(item2.Name);
        item1.FilePath.Should().Be(item2.FilePath);
        item1.Artist.Should().Be(item2.Artist);
        item1.Album.Should().Be(item2.Album);
        item1.PlayCount.Should().Be(item2.PlayCount);
        item1.Bookmarks.Should().HaveCount(item2.Bookmarks.Count);

        Bookmark[] orderedBms1 = item1.Bookmarks.OrderBy(b => b.ID).ToArray();
        Bookmark[] orderedBms2 = item2.Bookmarks.OrderBy(b => b.ID).ToArray();

        for (int i = 0; i < orderedBms1.Length; i++)
        {
            AssertBookmarksEqual(orderedBms1[i], orderedBms2[i]);
        }

        //this.AggregateId == other.AggregateId &&
        //    this.CreatedTimeUtc == other.CreatedTimeUtc &&
        //    this.Name == other.Name &&
        //    this.FilePath == other.FilePath &&
        //    this.Artist == other.Artist &&
        //    this.Album == other.Album &&
        //    this.PlayCount == other.PlayCount;
    }

    private static void AssertBookmarksEqual(Bookmark bm1, Bookmark bm2)
    {
        bm1.ID.Should().Be(bm2.ID);
        bm1.Position.Should().Be(bm2.Position);
        bm1.Emoji.Should().Be(bm2.Emoji);
        bm1.Comment.Should().Be(bm2.Comment);
    }

    // TODO: should add better equality comparers to the event classes themselves
    private static void AssertEventsAreEqual(IEvent event1, IEvent event2)
    {
        Assert.Equal(event1.Id, event2.Id);

        Assert.Equal(event1.AggregateId, event2.AggregateId);
        Assert.Equal(event1.CreatedTimeUtc, event2.CreatedTimeUtc);
        Assert.Equal(event1.MachineName, event2.MachineName);
        Assert.Equal(event1.GetType(), event2.GetType());
    }

    [Fact]
    public async Task TestControllerGetWorks()
    {
        HttpClient client = _factory.CreateClient();

        HttpResponseMessage response = await client.GetAsync("/test");

        response.EnsureSuccessStatusCode();

        string contents = await response.Content.ReadAsStringAsync();

        Assert.Equal("foo", contents);
    }

    [Fact]
    public async Task TestControllerGetWithParamWorks()
    {
        HttpClient client = _factory.CreateClient();

        HttpResponseMessage response = await client.GetAsync("/test/exclaim?input=foo");

        response.EnsureSuccessStatusCode();

        string contents = await response.Content.ReadAsStringAsync();

        Assert.Equal("foo!", contents);
    }

    [Fact]
    public async Task TestControllerGetEnumerable()
    {
        HttpClient client = _factory.CreateClient();

        HttpResponseMessage response = await client.GetAsync("/test/enumerable");

        response.EnsureSuccessStatusCode();

        string contents = await response.Content.ReadAsStringAsync();

        List<string> deserialized = JsonConvert.DeserializeObject<List<string>>(contents);

        Assert.Equal(2, deserialized.Count());
        Assert.Equal(TestController.GoodString, deserialized[0]);
        Assert.Equal(TestController.BadString, deserialized[1]);
    }

    [Fact]
    public async Task TestControllerPutOK()
    {
        HttpClient client = _factory.CreateClient();

        string uri = QueryHelpers.AddQueryString("/test/validate", "input", TestController.GoodString);

        HttpResponseMessage response = await client.PutAsync(uri, null);
        response.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task TestControllerPutFails()
    {
        HttpClient client = _factory.CreateClient();

        string uri = QueryHelpers.AddQueryString("/test/validate", "input", TestController.BadString);

        HttpResponseMessage response = await client.PutAsync(uri, null);
        Assert.False(response.IsSuccessStatusCode);
    }
}
