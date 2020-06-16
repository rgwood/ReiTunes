using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using ReiTunes.Core;

namespace ReiTunes.Core {

    public class LibraryItem : Aggregate {
        public string Name { get; set; }

        public string FilePath { get; set; }

        public string Artist { get; set; }
        public string Album { get; set; }
        public int? TrackNumber { get; set; }
        public DateTime CreatedTimeUtc { get; set; }

        public LibraryItem() {
        }

        public LibraryItem(string relativePath) {
            Id = Guid.NewGuid();
            Name = GetFileNameFromPath(relativePath);
            FilePath = relativePath;
            CreatedTimeUtc = DateTime.UtcNow;

            ApplyUncommitted(new LibraryItemCreatedEvent(Id, Name, FilePath, CreatedTimeUtc));
        }

        private string GetFileNameFromPath(string path) => path.Split('/').Last();

        protected override void RegisterAppliers() {
            this.RegisterApplier<LibraryItemCreatedEvent>(this.Apply);
        }

        private void Apply(LibraryItemCreatedEvent @event) {
            Id = @event.ItemId;
            Name = @event.Name;
            FilePath = @event.FilePath;
            CreatedTimeUtc = @event.CreatedTimeUtc;
        }
    }
}