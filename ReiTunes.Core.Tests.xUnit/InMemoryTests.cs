using ReiTunes.Core;
using System.Collections.Generic;
using Xunit;
using System;
using System.Linq;
using FluentAssertions;
using NuGet.Frameworks;
using System.Diagnostics;
using System.Collections;
using System.Data.SQLite;
using Serilog.Core;

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
                new object[] { new SQLiteEventRepository(new SQLiteConnection("DataSource=:memory:")) },
            };

        // Just test that lists serialize and deserialize without failing. Had some issues with that earlier
        [Fact]
        public async void Json_ListSerialization() {
            var l = new List<int>() { 1, 2, 3 };

            var serialized = await Json.SerializeAsync(l);
            var deserialized = await Json.DeserializeAsync<List<int>>(serialized);
            Assert.Equal(3, deserialized.Count);
        }

        [Fact]
        public void FuzzyMatchWorks_Basic() {
            var goodResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "rei");
            Assert.True(goodResult.isMatch);

            var badResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "xcv");
            Assert.False(badResult.isMatch);

            Assert.True(goodResult.score > badResult.score);
        }

        [Fact]
        public void FuzzyMatchGivesReasonableResult1() {
            var desired = "Solid Steel Radio Show 6_1_2012 Part 1 + 2 Bonobo Solid Steel Radio Show Solid Steel Radio/Solid Steel Radio Show 6_1_2012 Part 1 + 2 - Bonobo.mp3";
            var notDesired = "Breezeblock 2001-02-26 The Avalanches The Breezeblock Avalanches/The Avalanches on Radio 1 Breezebloc.mp3";

            TestFuzzyMatch(desired, notDesired, "bonobo");
            TestFuzzyMatch(desired, notDesired, "bonob");
        }

        private void TestFuzzyMatch(string desiredItem, string notDesiredItem, string searchText) {
            var desiredItemResult = FuzzyMatcher.FuzzyMatch(desiredItem, searchText);
            var notDesiredItemResult = FuzzyMatcher.FuzzyMatch(notDesiredItem, searchText);

            desiredItemResult.score.Should().BeGreaterThan(notDesiredItemResult.score);
        }

        [Theory]
        [MemberData(nameof(AllReposToTest))]
        public void CanGetEventsForSpecificMachine(IEventRepository repo) {
            const string machine1 = "machine1";
            const string machine2 = "machine2";
            var factory1 = new LibraryItemEventFactory(machine1, new Clock());
            var factory2 = new LibraryItemEventFactory(machine2, new Clock());

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
            var factory1 = new LibraryItemEventFactory(machine1, new Clock());
            var factory2 = new LibraryItemEventFactory(machine2, new Clock());

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
            item.ApplyEvents(new List<IEvent>() { createdEvent });

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

            itemFromEvents.ApplyEvents(repo.GetEvents(item.AggregateId));
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
            agg.ApplyEvents(new List<IEvent>() { createdEvent });

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
            agg2.ApplyEvents(repo.GetEvents(agg.AggregateId));

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
            var repo = new SQLiteEventRepository(new SQLiteConnection("DataSource=:memory:"));

            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetAllSerializedEvents().Count());
        }
    }
}