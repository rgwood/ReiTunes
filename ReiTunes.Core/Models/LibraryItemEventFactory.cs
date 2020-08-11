using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;

namespace ReiTunes.Core {

    public class LibraryItemEventFactory {
        private readonly string _machineName;
        private readonly IClock _clock;

        // Resets to zero every time the event factory is created. This is good enough for my needs right now but
        // maybe we should persist this?
        private long _currentLocalId;

        public LibraryItemEventFactory() : this(Environment.MachineName, new Clock()) {
        }

        public LibraryItemEventFactory(IClock clock) : this(Environment.MachineName, clock) {
        }

        public LibraryItemEventFactory(string machineName, IClock clock) {
            _machineName = machineName;
            _clock = clock;
        }

        public LibraryItemCreatedEvent GetCreatedEvent(Guid aggregateId, string name, string filePath) {
            return new LibraryItemCreatedEvent(Guid.NewGuid(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, name, filePath);
        }

        public LibraryItemNameChangedEvent GetNameChangedEvent(Guid aggregateId, string newName) {
            return new LibraryItemNameChangedEvent(Guid.NewGuid(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newName);
        }

        public LibraryItemAlbumChangedEvent GetAlbumChangedEvent(Guid aggregateId, string newAlbum) {
            return new LibraryItemAlbumChangedEvent(Guid.NewGuid(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newAlbum);
        }

        public LibraryItemArtistChangedEvent GetArtistChangedEvent(Guid aggregateId, string newArtist) {
            return new LibraryItemArtistChangedEvent(Guid.NewGuid(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newArtist);
        }

        public LibraryItemFilePathChangedEvent GetFilePathChangedEvent(Guid aggregateId, string newFilePath) {
            return new LibraryItemFilePathChangedEvent(Guid.NewGuid(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName, newFilePath);
        }

        public LibraryItemPlayedEvent GetPlayedEvent(Guid aggregateId) {
            return new LibraryItemPlayedEvent(Guid.NewGuid(), aggregateId, _clock.Now(), _clock.GetNextLocalId(), _machineName);
        }
    }
}