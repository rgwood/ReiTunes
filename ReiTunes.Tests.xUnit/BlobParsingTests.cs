using Xunit;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using ReiTunes.Helpers;

namespace ReiTunes.Test
{
    public class BlobParsingTests
    {
        string rawBlobList = @"Blah/DJ Set.mp3
Blah/DJ Set 2.mp3
DJ sdofkmgokm.m4a
ddoklmfglkm.mp3";

        [Fact]
        public void CanParseBlobList()
        {
            var explorerItems = FileTreeItemBuilder.ParseBlobList(rawBlobList);
            Assert.Equal(3, explorerItems.Count);
        }
    }
}