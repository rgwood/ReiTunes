using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;

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

        public LibraryItemCreatedEvent GetCreatedEvent(Guid aggregateId, string name, string filePath) {
            return new LibraryItemCreatedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, name, filePath);
        }

        public LibraryItemCreatedEvent GetCreatedEvent(Guid aggregateId, string name, string filePath, Guid eventId) {
            return new LibraryItemCreatedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, name, filePath);
        }

        public LibraryItemNameChangedEvent GetNameChangedEvent(Guid aggregateId, string newName) {
            return new LibraryItemNameChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newName);
        }

        public LibraryItemAlbumChangedEvent GetAlbumChangedEvent(Guid aggregateId, string newAlbum) {
            return new LibraryItemAlbumChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newAlbum);
        }

        public LibraryItemArtistChangedEvent GetArtistChangedEvent(Guid aggregateId, string newArtist) {
            return new LibraryItemArtistChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newArtist);
        }

        public LibraryItemFilePathChangedEvent GetFilePathChangedEvent(Guid aggregateId, string newFilePath) {
            return new LibraryItemFilePathChangedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newFilePath);
        }

        public LibraryItemPlayedEvent GetPlayedEvent(Guid aggregateId) {
            return new LibraryItemPlayedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName);
        }

        public LibraryItemDeletedEvent GetDeletedEvent(Guid aggregateId) {
            return new LibraryItemDeletedEvent(_guidFactory(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName);
        }
    }
}