using NUnit.Framework;
using ReiTunes.Common;
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace ReiTunes.Test
{
    public class JsonTests
    {
        [SetUp]
        public void Setup()
        {
        }

        [Test]
        public void CanSerializeAndDeserializeSampleData()
        {
            ObservableCollection<FileTreeItem> sampleData = FileTreeItem.GetSampleData();
            var serialized = JsonUtilities.Serialize(sampleData);
            JsonUtilities.Deserialize(serialized);
        }
    }
}