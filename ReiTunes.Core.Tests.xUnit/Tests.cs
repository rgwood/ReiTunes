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

            var createdEvent = new LibraryItemCreatedEvent(guid, name, path, createdDate);

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

            var createdEvent = new SimpleTextAggregateCreatedEvent(guid, createdDate, "foo");

            var agg = new SimpleTextAggregate();
            agg.ApplyEvents(new List<IEvent>() { createdEvent });

            Assert.Equal(guid, agg.Id);
            Assert.Equal("foo", agg.Text);

            agg.Apply(new SimpleTextAggregateUpdatedEvent(Guid.NewGuid(), DateTime.UtcNow, "bar"));

            Assert.Equal("bar", agg.Text);
        }

        [Fact]
        public void EditingSimpleAggregateCreatesEvents() {
            var guid = Guid.NewGuid();
            var createdDate = new DateTime(2020, 12, 25);

            var agg = new SimpleTextAggregate("foo");
            Assert.Single(agg.GetUncommitedChanges());
            Assert.Equal("foo", agg.Text);

            agg.Text = "bar";
            Assert.Equal(2, agg.GetUncommitedChanges().Count());
            Assert.Equal("bar", agg.Text);
        }

        [Fact]
        public void Scratch() {
            Console.WriteLine("foo");
            var guid = Guid.NewGuid();
            var name = "bar.mp3";
            var path = "foo/bar.mp3";
            var createdDate = new DateTime(2020, 12, 25);

            var createdEvent = new LibraryItemCreatedEvent(guid, name, path, createdDate);

            var serializedEvent = Json.Stringify(createdEvent);
        }
    }
}