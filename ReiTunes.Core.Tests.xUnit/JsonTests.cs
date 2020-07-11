using ReiTunes.Core;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using Xunit;

namespace ReiTunes.Test {

    public class JsonTests {
        //Disabled because we no longer need to serialize aggregates - we instead serialize their events
        //[Fact]
        //public async void CanSerializeAndDeserializeSampleData() {
        //    ObservableCollection<LibraryItem> sampleData = LibraryFileParser.GetSampleData();

        //    var serialized = await Json.StringifyAsync(sampleData);
        //    var deserialized = await Json.ToObjectAsync<List<LibraryItem>>(serialized);

        //    Assert.Equal(sampleData.Count, deserialized.Count);
        //}
    }
}