using ReiTunes.Core;
using Xunit;

namespace ReiTunes.Test
{
    public class BlobParsingTests
    {
        private string rawBlobList = @"Blah/DJ Set.mp3
Blah/DJ Set 2.mp3
DJ sdofkmgokm.m4a
ddoklmfglkm.mp3";

        [Fact]
        public void CanParseBlobList()
        {
            var explorerItems = LibraryFileParser.ParseBlobList(rawBlobList);
            Assert.Equal(4, explorerItems.Count);
        }
    }
}