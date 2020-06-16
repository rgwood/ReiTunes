namespace ReiTunes.Core

open System

//How to do an interface with a value
[<Interface>]
type IEvent =
  abstract Id: Guid
  abstract AggregateId: Guid
  abstract CreatedTimeUtc: DateTime;

type LibraryItemCreatedEvent =
  { Id: Guid;
    AggregateId: Guid;
    Name: string;
    FilePath: string;
    CreatedTimeUtc: DateTime; }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;
    member x.AggregateId = x.AggregateId;

type LibraryItemPlayedEvent =
  { Id: Guid;
    AggregateId: Guid;
    CreatedTimeUtc: DateTime; }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;
    member x.AggregateId = x.AggregateId;

type SimpleTextAggregateCreatedEvent =
  { Id: Guid;
    AggregateId: Guid;
    CreatedTimeUtc: DateTime;
    Text: string }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;
    member x.AggregateId = x.AggregateId;

type SimpleTextAggregateUpdatedEvent =
  { Id: Guid;
    AggregateId: Guid;
    CreatedTimeUtc: DateTime;
    Text: string }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;
    member x.AggregateId = x.AggregateId;