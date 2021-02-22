using System;

namespace ReiTunes.Core {

    public class LibraryItemEventFactory {
        private readonly string _machineName;
        private readonly Func<Guid> _guidFactory;
        private readonly IClock _clock;

        public LibraryItemEventFactory(IClock clock = null, string machineName = null, Func<Guid> guidFactory = null) {
            _clock = clock ?? new Clock();
            _machineName = machineName ?? Environment.MachineName;
            _guidFactory = guidFactory ?? (() => Guid.NewGuid());
        }

        public LibraryItemCreatedEvent GetCreatedEvent(Guid aggregateId, string name, string filePath)
            => new LibraryItemCreatedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, name, filePath);

        public LibraryItemNameChangedEvent GetNameChangedEvent(Guid aggregateId, string newName)
            => new LibraryItemNameChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newName);

        public LibraryItemAlbumChangedEvent GetAlbumChangedEvent(Guid aggregateId, string newAlbum)
            => new LibraryItemAlbumChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newAlbum);

        public LibraryItemArtistChangedEvent GetArtistChangedEvent(Guid aggregateId, string newArtist)
            => new LibraryItemArtistChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newArtist);

        public LibraryItemFilePathChangedEvent GetFilePathChangedEvent(Guid aggregateId, string newFilePath)
            => new LibraryItemFilePathChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newFilePath);

        public LibraryItemPlayedEvent GetPlayedEvent(Guid aggregateId)
            => new LibraryItemPlayedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName);

        public LibraryItemDeletedEvent GetDeletedEvent(Guid aggregateId)
            => new LibraryItemDeletedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName);

        public LibraryItemBookmarkAddedEvent GetBookmarkAddedEvent(Guid aggregateId, Guid bookmarkId, TimeSpan position)
            => new LibraryItemBookmarkAddedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName,
                bookmarkId, position);

        public LibraryItemBookmarkDeletedEvent GetBookmarkDeletedEvent(Guid aggregateId, Guid bookmarkId)
            => new LibraryItemBookmarkDeletedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName,
                bookmarkId);

        public LibraryItemBookmarkSetEmojiEvent GetBookmarkSetEmojiEvent(Guid aggregateId, Guid bookmarkId, string emoji)
            => new LibraryItemBookmarkSetEmojiEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName,
                bookmarkId, emoji);
    }
}