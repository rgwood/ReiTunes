using System;
using System.Collections.ObjectModel;
using System.Linq;

namespace ReiTunes.Core {
    // TODO: this should probably be a
    public record Bookmark(Guid ID, TimeSpan Position, char? Emoji, string Comment = null) {
        public virtual bool Equals(Bookmark other) => ID == other?.ID;
        public override int GetHashCode() => ID.GetHashCode();
    }

    public class LibraryItem : Aggregate, IEquatable<LibraryItem> {
        private ObservableCollection<Bookmark> _bookmarks = new ObservableCollection<Bookmark>();
        public ObservableCollection<Bookmark> Bookmarks => _bookmarks;

        public void AddBookmark(TimeSpan position) {
            ApplyButDoNotCommit(_eventFactory.GetBookmarkAddedEvent(AggregateId, Guid.NewGuid(), position));
            NotifyPropertyChanged(nameof(Bookmarks));
        }

        private string _name;

        public string Name {
            get => _name;
            set {
                if (_name != value) {
                    ApplyButDoNotCommit(_eventFactory.GetNameChangedEvent(AggregateId, value));
                    NotifyPropertyChanged();
                }
            }
        }

        private string _filePath;

        public string FilePath {
            get => _filePath;
            set {
                if (_filePath != value) {
                    ApplyButDoNotCommit(_eventFactory.GetFilePathChangedEvent(AggregateId, value));
                    NotifyPropertyChanged();
                }
            }
        }

        private string _artist;

        public string Artist {
            get => _artist;
            set {
                if (_artist != value) {
                    ApplyButDoNotCommit(_eventFactory.GetArtistChangedEvent(AggregateId, value));
                    NotifyPropertyChanged();
                }
            }
        }

        private string _album;

        public string Album {
            get => _album;
            set {
                if (_album != value) {
                    ApplyButDoNotCommit(_eventFactory.GetAlbumChangedEvent(AggregateId, value));
                    NotifyPropertyChanged();
                }
            }
        }

        private int _playCount = 0;
        private readonly LibraryItemEventFactory _eventFactory;

        public DateTime CreatedTimeLocal => CreatedTimeUtc.ToLocalTime();

        /// <summary>
        /// Was a tombstone event seen (i.e. was this deleted)?
        /// </summary>
        public bool Tombstoned => _tombStoned;

        private bool _tombStoned = false;

        public int PlayCount => _playCount;

        // a single string with everything we might want to include in text search, useful for fuzzy find
        public string AllSearchProperties {
            get {
                return $"{Name} {Artist} {Album} {FilePath}";
            }
        }

        public LibraryItem(LibraryItemEventFactory eventFactory) {
            _eventFactory = eventFactory;
        }

        public LibraryItem(LibraryItemEventFactory eventFactory, string relativePath) : this(eventFactory) {
            var fileName = GetFileNameFromPath(relativePath);
            ApplyButDoNotCommit(_eventFactory.GetCreatedEvent(Guid.NewGuid(), fileName, relativePath));
        }

        public void IncrementPlayCount() {
            ApplyButDoNotCommit(_eventFactory.GetPlayedEvent(AggregateId));
        }

        private string GetFileNameFromPath(string path) => path.Split('/').Last();

        protected override void RegisterAppliers() {
            this.RegisterApplier<LibraryItemCreatedEvent>(this.Apply);
            this.RegisterApplier<LibraryItemPlayedEvent>(this.Apply);
            this.RegisterApplier<LibraryItemDeletedEvent>(this.Apply);
            this.RegisterApplier<LibraryItemNameChangedEvent>(this.Apply);
            this.RegisterApplier<LibraryItemFilePathChangedEvent>(this.Apply);
            this.RegisterApplier<LibraryItemAlbumChangedEvent>(this.Apply);
            this.RegisterApplier<LibraryItemArtistChangedEvent>(this.Apply);

            this.RegisterApplier<LibraryItemBookmarkAddedEvent>(this.Apply);
        }

        private void Apply(LibraryItemCreatedEvent @event) {
            AggregateId = @event.AggregateId;
            _name = @event.Name;
            _filePath = @event.FilePath;
            if (@event.CreatedTimeUtc.Kind != DateTimeKind.Utc) {
                throw new Exception($"Aggregate {@event.AggregateId} has a CreatedTimeUtc in {@event.CreatedTimeUtc.Kind} not UTC, wtf?");
            }
            CreatedTimeUtc = @event.CreatedTimeUtc;
        }

        private void Apply(LibraryItemPlayedEvent @event) {
            _playCount++;
            NotifyPropertyChanged(nameof(PlayCount));
        }

        private void Apply(LibraryItemDeletedEvent @event) {
            _tombStoned = true;
        }

        private void Apply(LibraryItemNameChangedEvent @event) {
            _name = @event.NewName;
            NotifyPropertyChanged(nameof(Name));
        }

        private void Apply(LibraryItemFilePathChangedEvent @event) {
            _filePath = @event.NewFilePath;
            NotifyPropertyChanged(nameof(FilePath));
        }

        private void Apply(LibraryItemAlbumChangedEvent @event) {
            _album = @event.NewAlbum;
            NotifyPropertyChanged(nameof(Album));
        }

        private void Apply(LibraryItemArtistChangedEvent @event) {
            _artist = @event.NewArtist;
            NotifyPropertyChanged(nameof(Artist));
        }

        private void Apply(LibraryItemBookmarkAddedEvent @event) {
            Bookmarks.Add(new Bookmark(@event.BookmarkId, @event.Position, null));
            NotifyPropertyChanged(nameof(Bookmarks));
        }

        public override bool Equals(object obj) {
            return this.Equals(obj as LibraryItem);
        }

        public bool Equals(LibraryItem other) {
            if (Object.ReferenceEquals(other, null))
                return false;

            if (Object.ReferenceEquals(this, other))
                return true;

            return this.AggregateId == other.AggregateId &&
                this.CreatedTimeUtc == other.CreatedTimeUtc &&
                this.Name == other.Name &&
                this.FilePath == other.FilePath &&
                this.Artist == other.Artist &&
                this.Album == other.Album &&
                this.PlayCount == other.PlayCount;
        }

        public static bool operator ==(LibraryItem lhs, LibraryItem rhs) {
            // Check for null on left side.
            if (Object.ReferenceEquals(lhs, null)) {
                if (Object.ReferenceEquals(rhs, null)) {
                    // null == null = true.
                    return true;
                }

                // Only the left side is null.
                return false;
            }
            // Equals handles case of null on right side.
            return lhs.Equals(rhs);
        }

        public static bool operator !=(LibraryItem lhs, LibraryItem rhs) {
            return !(lhs == rhs);
        }

        public override int GetHashCode() {
            return AggregateId.GetHashCode();
        }
    }
}