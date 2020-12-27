using FluentAssertions;
using Microsoft.Data.Sqlite;
using System;
using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace ReiTunes.Core.Tests.XUnit {

    public class InMemoryTests {
        private readonly LibraryItemEventFactory _eventFactory;

        public InMemoryTests() {
            _eventFactory = new LibraryItemEventFactory();
        }

        public static IEnumerable<object[]> AllReposToTest =>
            new List<object[]>
            {
                new object[] { new InMemoryEventRepository() },
                new object[] { new InMemoryJsonEventRepository() },
                new object[] { new SQLiteEventRepository(new SqliteConnection("DataSource=:memory:")) },
            };

        // Just test that lists serialize and deserialize without failing. Had some issues with that earlier
        [Fact]
        public async void Json_ListSerialization() {
            var l = new List<int>() { 1, 2, 3 };

            var serialized = await Json.SerializeAsync(l);
            var deserialized = await Json.DeserializeAsync<List<int>>(serialized);
            Assert.Equal(3, deserialized.Count);
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void CanGetEventsForSpecificMachine(IEventRepository repo) {
            const string machine1 = "machine1";
            const string machine2 = "machine2";
            var factory1 = new LibraryItemEventFactory(new Clock(), machine1);
            var factory2 = new LibraryItemEventFactory(new Clock(), machine2);

            var guid = Guid.NewGuid();

            repo.Save(factory1.GetPlayedEvent(guid));
            repo.Save(factory2.GetPlayedEvent(guid));

            repo.GetAllEvents().Count().Should().Be(2);
            repo.GetAllEventsFromMachine(machine1).Count().Should().Be(1);
            repo.GetAllEventsFromMachine(machine2).Count().Should().Be(1);
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void CanGetEventsMachineNameCaseDoesNotMatter(IEventRepository repo) {
            const string machine1 = "machine1";
            const string machine2 = "machine2";
            var factory1 = new LibraryItemEventFactory(new Clock(), machine1);
            var factory2 = new LibraryItemEventFactory(new Clock(), machine2);

            var guid = Guid.NewGuid();

            repo.Save(factory1.GetPlayedEvent(guid));

            repo.GetAllEventsFromMachine(machine1.ToUpper()).Count().Should().Be(1);

            repo.GetAllEventsFromMachine(machine2.ToUpper()).Count().Should().Be(0);

            repo.Save(factory2.GetPlayedEvent(guid));
            repo.GetAllEventsFromMachine(machine2.ToUpper()).Count().Should().Be(1);
        }

        [Fact]
        public void CanCreateLibraryItemFromEvent() {
            var guid = Guid.NewGuid();
            var name = "bar.mp3";
            var path = "foo/bar.mp3";

            var createdEvent = _eventFactory.GetCreatedEvent(guid, name, path);
            //new LibraryItemCreatedEvent(Guid.NewGuid(), guid, createdDate, name, path);

            var item = new LibraryItem(_eventFactory);
            item.Apply(new List<IEvent>() { createdEvent });

            Assert.Equal(guid, item.AggregateId);
            Assert.Equal(name, item.Name);
            Assert.Equal(path, item.FilePath);
            Assert.Equal(createdEvent.CreatedTimeUtc, item.CreatedTimeUtc);
        }

        [Fact]
        public void LibraryItemIncrementPlayCountWorks() {
            var item = new LibraryItem(_eventFactory, "foo/bar.mp3");

            Assert.Equal(0, item.PlayCount);

            item.IncrementPlayCount();

            ItemCanBeRebuiltFromUncommittedEvents(item);

            Assert.Equal(1, item.PlayCount);
        }

        [Fact]
        public void LibraryItemAddBookmarkWorks() {
            var item = new LibraryItem(_eventFactory, "foo/bar.mp3");

            item.Bookmarks.Count.Should().Be(0);

            var addBookmarkEvent = _eventFactory.GetBookmarkAddedEvent(item.AggregateId, Guid.NewGuid(), TimeSpan.FromSeconds(42));

            item.Apply(addBookmarkEvent);

            var bookmark = item.Bookmarks.Single();

            bookmark.Position.Should().Be(TimeSpan.FromSeconds(42));
            bookmark.Emoji.Should().BeNull();
            bookmark.Comment.Should().BeNull();
        }

        [Fact]
        public void CanSerializeDeserializeAllLibraryItemEvents() {
            var item = new LibraryItem(_eventFactory, "foo/bar.mp3");

            Assert.Equal(0, item.PlayCount);

            item.IncrementPlayCount();

            ItemCanBeRebuiltFromUncommittedEvents(item);

            Assert.Equal(1, item.PlayCount);
        }

        [Fact]
        public void LibraryItemNameChangeWorks() {
            var item = new LibraryItem(_eventFactory, "foo/bar.mp3");
            item.Name = item.Name + "x";
            Assert.Equal(2, item.GetUncommittedEvents().Count());
            ItemCanBeRebuiltFromUncommittedEvents(item);
        }

        [Fact]
        public void LibraryItemFilePathChangeWorks() {
            var item = new LibraryItem(_eventFactory, "foo/bar.mp3");
            item.FilePath = item.FilePath + "x";
            Assert.Equal(2, item.GetUncommittedEvents().Count());
            ItemCanBeRebuiltFromUncommittedEvents(item);
        }

        // Tabbing through the datagrid generates meaningless set calls that just set value = oldValue. Make sure these don't generate events
        [Fact]
        public void NoEventsGeneratedIfDataHasNotChanged() {
            var item = new LibraryItem(_eventFactory, "foo/bar.mp3");
            item.Commit();
            item.Album = item.Album;
            item.Artist = item.Artist;
            item.FilePath = item.FilePath;
            item.Name = item.Name;
            Assert.Empty(item.GetUncommittedEvents());
        }

        private void ItemCanBeRebuiltFromUncommittedEvents(LibraryItem item) {
            var itemFromEvents = new LibraryItem(_eventFactory);

            var events = item.GetUncommittedEvents();

            var repo = new InMemoryJsonEventRepository();

            foreach (var @event in events) {
                repo.Save(@event);
            }

            itemFromEvents.Apply(repo.GetEvents(item.AggregateId));
            Assert.Equal(item, itemFromEvents);
        }

        //results: hella fast, 2.5s for a million events. Suggests that disk and network will be the bottlenecks
        //[Fact]
        //public void Benchmark() {
        //    var item = new LibraryItem("foo.mp3");

        //    var sw = Stopwatch.StartNew();

        //    for (int i = 0; i < 1000000; i++) {
        //        item.IncrementPlayCount();
        //        item.Name = "foo" + i;
        //        item.Album = "album " + i;
        //    }
        //    sw.Stop();

        //    Console.WriteLine($"Make changes: {sw.ElapsedMilliseconds}ms");

        //    var allEvents = item.GetUncommittedEvents();

        //    sw = Stopwatch.StartNew();

        //    var newItem = new LibraryItem();
        //    newItem.ApplyEvents(allEvents);
        //    sw.Stop();
        //    Console.WriteLine($"Apply changes: {sw.ElapsedMilliseconds}ms");
        //}

        [Fact]
        public void TestSimpleTextAggregate() {
            var guid = Guid.NewGuid();
            var createdDate = new DateTime(2020, 12, 25);

            var createdEvent = new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), guid, createdDate, "foo");

            var agg = new SimpleTextAggregate();
            agg.Apply(new List<IEvent>() { createdEvent });

            Assert.Equal(guid, agg.AggregateId);
            Assert.Equal("foo", agg.Text);

            agg.Apply(new SimpleTextAggregateUpdatedEvent(Guid.NewGuid(), guid, DateTime.UtcNow, "bar"));

            Assert.Equal("bar", agg.Text);
        }

        [Fact]
        public void EditingSimpleAggregateCreatesEvents() {
            var agg = new SimpleTextAggregate("foo");
            Assert.Single(agg.GetUncommittedEvents());
            Assert.Equal("foo", agg.Text);

            agg.Text = "bar";
            Assert.Equal(2, agg.GetUncommittedEvents().Count());
            Assert.Equal("bar", agg.Text);
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void CanPersistAndRehydrateSimpleAggregate(IEventRepository repo) {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetEvents(agg.AggregateId).Count());

            agg.Commit();

            var agg2 = new SimpleTextAggregate();
            agg2.Apply(repo.GetEvents(agg.AggregateId));

            Assert.Equal(agg.AggregateId, agg2.AggregateId);
            Assert.Equal(agg.Text, agg2.Text);
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void ContainsEventWorks(IEventRepository repo) {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            foreach (var @event in agg.GetUncommittedEvents()) {
                Assert.False(repo.ContainsEvent(@event.Id));
                repo.Save(@event);
                Assert.True(repo.ContainsEvent(@event.Id));
            }
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void WillNotSaveSameEventTwice(IEventRepository repo) {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetAllEvents().Count());

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetAllEvents().Count());
        }

        [Fact]
        public void EventsHaveCorrectAggregateType() {
            var guid = Guid.NewGuid();
            var createdDate = new DateTime(2020, 12, 25);
            var simpleEvent = new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), guid, createdDate, "foo");

            Assert.Equal("SimpleTextAggregate", simpleEvent.AggregateType);

            var libraryItemEvent = _eventFactory.GetCreatedEvent(guid, "foo", "bar");
            Assert.Equal("LibraryItem", libraryItemEvent.AggregateType);
        }

        [Fact]
        public void GetSerializedEventsWorks() {
            var repo = new SQLiteEventRepository(new SqliteConnection("DataSource=:memory:"));

            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetAllSerializedEvents().Count());
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void EventCountWorks(IEventRepository repo) {
            repo.CountOfAllEvents().Should().Be(0);

            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            repo.Save(_eventFactory.GetCreatedEvent(Guid.NewGuid(), "foo", "bar"));

            repo.CountOfAllEvents().Should().Be(1);

            repo.Save(_eventFactory.GetPlayedEvent(Guid.NewGuid()));

            repo.CountOfAllEvents().Should().Be(2);
        }
    }
}