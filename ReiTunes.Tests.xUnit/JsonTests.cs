using ReiTunes.Core.Helpers;
using ReiTunes.Helpers;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using Xunit;

namespace ReiTunes.Test
{
    public class JsonTests
    {
        [Fact]
        public async void CanSerializeAndDeserializeSampleData()
        {
            ObservableCollection<FileTreeItem> sampleData = FileTreeBuilder.GetSampleData();

            var serialized = await Json.StringifyAsync(sampleData);
            var deserialized = await Json.ToObjectAsync<List<FileTreeItem>>(serialized);

            Assert.Equal(sampleData.Count, deserialized.Count);
        }
    }
}