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

        // MachineName needs to be set after the event is created, because aggregates don't necessarily know the machine name
        public string MachineName { get; set; }
    }

    public class SimpleTextAggregateCreatedEvent : IEvent {
        public Guid Id { get; private set; }
        public Guid AggregateId { get; private set; }
        public DateTime CreatedTimeUtc { get; private set; }
        public string Text { get; private set; }
        public string MachineName { get; set; }

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
        public string Text { get; private set; }
        public string MachineName { get; set; }

        public SimpleTextAggregateUpdatedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, string text) {
            Id = id;
            AggregateId = aggregateId;
            CreatedTimeUtc = createdTimeUtc;
            Text = text;
        }
    }

    public class LibraryItemCreatedEvent : IEvent {
        public Guid Id { get; private set; }
        public Guid AggregateId { get; private set; }
        public DateTime CreatedTimeUtc { get; private set; }
        public string Name { get; private set; }
        public string FilePath { get; private set; }
        public string MachineName { get; set; }

        public LibraryItemCreatedEvent(Guid id, Guid aggregateId, DateTime createdTimeUtc, string name, string filePath) {
            Id = id;
            AggregateId = aggregateId;
            CreatedTimeUtc = createdTimeUtc;
            Name = name;
            FilePath = filePath;
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