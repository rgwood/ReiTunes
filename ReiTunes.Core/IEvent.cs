using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public interface IEvent {
        public Guid Id { get; }
        public Guid AggregateId { get; }

        // wonder if I should be using a fancier time type from Noda Time...
        public DateTime CreatedTimeUtc { get; }

        /// <summary>
        /// For ordering items created close to each other. Items created later will have a higher LocalId
        /// </summary>
        public long LocalId { get; }

        public string MachineName { get; }

        // Not sure if this is needed
        [JsonIgnore]
        public string AggregateType { get; }
    }

    public class SimpleTextAggregateCreatedEvent : IEvent {
        public Guid Id { get; private set; }
        public Guid AggregateId { get; private set; }
        public DateTime CreatedTimeUtc { get; private set; }
        public long LocalId { get; private set; }
        public string Text { get; private set; }
        public string MachineName { get; set; } = "placeholder";

        public string AggregateType => nameof(SimpleTextAggregate);

        public SimpleTextAggregateCreatedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, string text) {
            Id = id;
            AggregateId = aggregateId;
            CreatedTimeUtc = createdTimeUtc;
            Text = text;
        }
    }

    public class SimpleTextAggregateUpdatedEvent : IEvent {
        public Guid Id { get; private set; }
        public Guid AggregateId { get; private set; }
        public DateTime CreatedTimeUtc { get; private set; }
        public long LocalId { get; private set; }
        public string Text { get; private set; }
        public string MachineName { get; set; } = "placeholder";

        public string AggregateType => nameof(SimpleTextAggregate);

        public SimpleTextAggregateUpdatedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, string text) {
            Id = id;
            AggregateId = aggregateId;
            CreatedTimeUtc = createdTimeUtc;
            Text = text;
        }
    }

    public abstract class LibraryItemEvent : IEvent {
        public Guid Id { get; private set; }
        public Guid AggregateId { get; private set; }
        public DateTime CreatedTimeUtc { get; private set; }
        public long LocalId { get; private set; }
        public string MachineName { get; private set; }

        public string AggregateType => nameof(LibraryItem);

        public LibraryItemEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName) {
            Id = id;
            AggregateId = aggregateId;
            CreatedTimeUtc = createdTimeUtc;
            LocalId = localId;
            MachineName = machineName;
        }
    }

    public class LibraryItemCreatedEvent : LibraryItemEvent {
        public string Name { get; private set; }
        public string FilePath { get; private set; }

        public LibraryItemCreatedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName, string name, string filePath)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
            Name = name;
            FilePath = filePath;
        }
    }

    public class LibraryItemDeletedEvent : LibraryItemEvent {

        public LibraryItemDeletedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
        }
    }

    public class LibraryItemNameChangedEvent : LibraryItemEvent {
        public string NewName { get; private set; }

        public LibraryItemNameChangedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName, string newName)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
            NewName = newName;
        }
    }

    public class LibraryItemFilePathChangedEvent : LibraryItemEvent {
        public string NewFilePath { get; private set; }

        public LibraryItemFilePathChangedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName, string newFilePath)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
            NewFilePath = newFilePath;
        }
    }

    public class LibraryItemArtistChangedEvent : LibraryItemEvent {
        public string NewArtist { get; private set; }

        public LibraryItemArtistChangedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName, string newArtist)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
            NewArtist = newArtist;
        }
    }

    public class LibraryItemAlbumChangedEvent : LibraryItemEvent {
        public string NewAlbum { get; private set; }

        public LibraryItemAlbumChangedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName, string newAlbum)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
            NewAlbum = newAlbum;
        }
    }

    public class LibraryItemPlayedEvent : LibraryItemEvent {

        public LibraryItemPlayedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, long localId, string machineName)
            : base(id, aggregateId, createdTimeUtc, localId, machineName) {
        }
    }
}

//type LibraryItemCreatedEvent =
//  { Id: Guid;
//    AggregateId: Guid;
//    Name: string;
//    FilePath: string;
//    CreatedTimeUtc: DateTime; }
//  interface IEvent with
//    member x.CreatedTimeUtc = x.CreatedTimeUtc;
//    member x.Id = x.Id;
//    member x.AggregateId = x.AggregateId;

//type LibraryItemPlayedEvent =
//  { Id: Guid;
//    AggregateId: Guid;
//    CreatedTimeUtc: DateTime; }
//  interface IEvent with
//    member x.CreatedTimeUtc = x.CreatedTimeUtc;
//    member x.Id = x.Id;
//    member x.AggregateId = x.AggregateId;

//type SimpleTextAggregateCreatedEvent =
//  { Id: Guid;
//    AggregateId: Guid;
//    CreatedTimeUtc: DateTime;
//    Text: string }
//  interface IEvent with
//    member x.CreatedTimeUtc = x.CreatedTimeUtc;
//    member x.Id = x.Id;
//    member x.AggregateId = x.AggregateId;

//type SimpleTextAggregateUpdatedEvent =
//  { Id: Guid;
//    AggregateId: Guid;
//    CreatedTimeUtc: DateTime;
//    Text: string }
//  interface IEvent with
//    member x.CreatedTimeUtc = x.CreatedTimeUtc;
//    member x.Id = x.Id;
//    member x.AggregateId = x.AggregateId;