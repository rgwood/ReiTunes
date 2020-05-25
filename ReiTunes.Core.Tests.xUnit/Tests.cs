using ReiTunes.Core.Helpers;
using System;
using System.Collections.Generic;
using Xunit;

namespace ReiTunes.Core.Tests.XUnit
{
    public class Tests
    {
        // Just test that lists serialize and deserialize without failing. Had some issues with that earlier
        [Fact]
        public async void Json_ListSerialization()
        {
            var l = new List<int>() { 1, 2, 3 };

            var serialized = await Json.StringifyAsync(l);
            var deserialized = await Json.ToObjectAsync<List<int>>(serialized);
            Assert.Equal(3, deserialized.Count);
        }
    }
}
