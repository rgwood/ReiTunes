using ReiTunes.Core;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using Xunit;
using ApprovalTests;
using System;
using ApprovalTests.Reporters;
using ApprovalTests.Reporters.ContinuousIntegration;

namespace ReiTunes.Test {

    public class JsonSnapshotTests {

        private const string MachineName = "Cornelius";
        private static readonly Guid _item1ID = new("47b04010-5bc0-410e-9803-f5d6f3c5badc");
        private readonly LibraryItemEventFactory _factory = new(
            new NeverIncreasingClock(),
            MachineName,
            () => Guid.Empty);

        private static void VerifyJson(IEvent ev) {
            string text = EventSerialization.PrettyPrint(ev);
            Approvals.Verify(text);
        }

        [Fact]
        public void ItemCreatedEvent() => 
            VerifyJson(_factory.GetCreatedEvent(_item1ID, "Hello 🌎", "foo/bar.mp3"));

        [Fact]
        public void ItemPlayedEvent() =>
            VerifyJson(_factory.GetPlayedEvent(_item1ID));

        [Fact]
        public void ItemNameChangedEvent() =>
            VerifyJson(_factory.GetNameChangedEvent(_item1ID, "newName"));

    }
}