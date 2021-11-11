using ApprovalTests;
using ApprovalTests.Reporters;
using ReiTunes.Core;
using System;
using Xunit;

namespace ReiTunes.Test;

[UseReporter(typeof(BeyondCompareReporter))]
public class JsonSnapshotTests
{
    private const string MachineName = "Cornelius";
    private static readonly Guid _item1ID = new("47b04010-5bc0-410e-9803-f5d6f3c5badc");
    private static readonly Guid _item2ID = new("a8fd3845-7b54-4a72-a818-bb7af3c6d3cc");

    private readonly LibraryItemEventFactory _factory = new(
        new NeverIncreasingClock(),
        MachineName,
        () => Guid.Empty);

    private static void VerifyJson(IEvent ev)
    {
        string text = EventSerialization.PrettyPrint(ev);
        Approvals.Verify(text);
    }

    [Fact]
    public void ItemCreatedEvent() =>
        VerifyJson(_factory.GetCreatedEvent(_item1ID, "Hello 🌎", "foo/bar.mp3"));

    [Fact]
    public void ItemDeletedEvent() =>
        VerifyJson(_factory.GetDeletedEvent(_item1ID));

    [Fact]
    public void ItemPlayedEvent() =>
        VerifyJson(_factory.GetPlayedEvent(_item1ID));

    [Fact]
    public void ItemNameChangedEvent() =>
        VerifyJson(_factory.GetNameChangedEvent(_item1ID, "newName"));

    [Fact]
    public void ItemAlbumChangedEvent() =>
        VerifyJson(_factory.GetAlbumChangedEvent(_item1ID, "newAlbumName"));

    [Fact]
    public void ItemArtistChangedEvent() =>
        VerifyJson(_factory.GetArtistChangedEvent(_item1ID, "newArtistName"));

    [Fact]
    public void ItemFilePathChangedEvent() =>
        VerifyJson(_factory.GetFilePathChangedEvent(_item1ID, "newFilePath.mp3"));

    [Fact]
    public void BookmarkAddedEvent() =>
        VerifyJson(_factory.GetBookmarkAddedEvent(_item1ID, _item2ID, TimeSpan.FromSeconds(99)));

    [Fact]
    public void BookmarkDeletedEvent() =>
        VerifyJson(_factory.GetBookmarkDeletedEvent(_item1ID, _item2ID));

    //[Fact]
    //public void BookmarkSetEmojiEvent() =>
    //    VerifyJson(_factory.GetBookmarkSetEmojiEvent(_item1ID, _item2ID, '🤔'));
}
