using ReiTunes.Core;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using Xunit;

namespace ReiTunes.Test {

    public class JsonTests {

        [Fact]
        public async void CanSerializeAndDeserializeSampleData() {
            ObservableCollection<LibraryItem> sampleData = LibraryFileParser.GetSampleData();

            var serialized = await Json.StringifyAsync(sampleData);
            var deserialized = await Json.ToObjectAsync<List<LibraryItem>>(serialized);

            Assert.Equal(sampleData.Count, deserialized.Count);
        }
    }
}