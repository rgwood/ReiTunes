using NUnit.Framework;
using ReiTunes.Common;
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace ReiTunes.Test
{
    public class BlobParsingTests
    {
        string rawBlobList = @"Blah/DJ Set.mp3
Blah/DJ Set 2.mp3
DJ sdofkmgokm.m4a
ddoklmfglkm.mp3";

        [SetUp]
        public void Setup()
        {
        }

        [Test]
        public void CanParseBlobList()
        {
            var explorerItems = FileTreeItemBuilder.ParseBlobList(rawBlobList);
            Assert.AreEqual(3, explorerItems.Count);
        }
    }
}