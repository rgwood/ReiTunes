using ReiTunes.Core;
using System.Collections.Generic;
using Xunit;
using System;
using System.Linq;

namespace ReiTunes.Core.Tests.XUnit {

    public class Tests {

        // Just test that lists serialize and deserialize without failing. Had some issues with that earlier
        [Fact]
        public async void Json_ListSerialization() {
            var l = new List<int>() { 1, 2, 3 };

            var serialized = await Json.StringifyAsync(l);
            var deserialized = await Json.ToObjectAsync<List<int>>(serialized);
            Assert.Equal(3, deserialized.Count);
        }

        [Fact]
        public void FuzzyMatchWorks() {
            var goodResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "rei");
            Assert.True(goodResult.isMatch);

            var badResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "xcv");
            Assert.False(badResult.isMatch);

            Assert.True(goodResult.score > badResult.score);
        }

        [Fact]
        public void CanCreateLibraryItemFromEvent() {
            var guid = Guid.NewGuid();
            var name = "bar.mp3";
            var path = "foo/bar.mp3";
            var createdDate = new DateTime(2020, 12, 25);

            var createdEvent = new LibraryItemCreatedEvent(Guid.NewGuid(), guid, name, path, createdDate);

            var item = new LibraryItem();
            item.ApplyEvents(new List<IEvent>() { createdEvent });

            Assert.Equal(guid, item.Id);
            Assert.Equal(name, item.Name);
            Assert.Equal(path, item.FilePath);
            Assert.Equal(createdDate, item.CreatedTimeUtc);
        }

        [Fact]
        public void TestSimpleTextAggregate() {
            var guid = Guid.NewGuid();
            var createdDate = new DateTime(2020, 12, 25);

            var createdEvent = new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), guid, createdDate, "foo");

            var agg = new SimpleTextAggregate();
            agg.ApplyEvents(new List<IEvent>() { createdEvent });

            Assert.Equal(guid, agg.Id);
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

        [Fact]
        public void CanPersistAndRehydrateSimpleAggregate() {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            var repo = new InMemoryEventRepository();

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetEvents(agg.Id).Count());

            agg.Commit();

            var agg2 = new SimpleTextAggregate();
            agg2.ApplyEvents(repo.GetEvents(agg.Id));

            Assert.Equal(agg.Id, agg2.Id);
            Assert.Equal(agg.Text, agg2.Text);
        }

        [Fact]
        public void CanPersistAndRehydrateSimpleAggregateToFromJson() {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            var repo = new InMemoryJsonEventRepository();

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetEvents(agg.Id).Count());

            agg.Commit();

            var agg2 = new SimpleTextAggregate();
            agg2.ApplyEvents(repo.GetEvents(agg.Id));

            Assert.Equal(agg.Id, agg2.Id);
            Assert.Equal(agg.Text, agg2.Text);
        }

        [Fact]
        public void Scratch() {
            Console.WriteLine("foo");
            var guid = Guid.NewGuid();
            var name = "bar.mp3";
            var path = "foo/bar.mp3";
            var createdDate = new DateTime(2020, 12, 25);
        }

        [Fact]
        public void ContainsEventWorks_JsonRepo() {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            IEventRepository repo = new InMemoryJsonEventRepository();

            foreach (var @event in agg.GetUncommittedEvents()) {
                Assert.False(repo.ContainsEvent(@event.Id));
                repo.Save(@event);
                Assert.True(repo.ContainsEvent(@event.Id));
            }
        }

        [Fact]
        public void ContainsEventWorks_InMemoryRepo() {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            IEventRepository repo = new InMemoryEventRepository();

            foreach (var @event in agg.GetUncommittedEvents()) {
                Assert.False(repo.ContainsEvent(@event.Id));
                repo.Save(@event);
                Assert.True(repo.ContainsEvent(@event.Id));
            }
        }

        [Fact]
        public void WillNotSaveSameEventTwice_JsonRepo() {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            IEventRepository repo = new InMemoryJsonEventRepository();

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
        public void WillNotSaveSameEventTwice_InMemoryRepo() {
            var agg = new SimpleTextAggregate("foo");
            agg.Text = "bar";

            IEventRepository repo = new InMemoryEventRepository();

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetAllEvents().Count());

            foreach (var @event in agg.GetUncommittedEvents()) {
                repo.Save(@event);
            }

            Assert.Equal(2, repo.GetAllEvents().Count());
        }
    }
}