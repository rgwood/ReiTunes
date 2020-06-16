namespace ReiTunes.Core

open System

//How to do an interface with a value
[<Interface>]
type IEvent =
  abstract Id: Guid
  abstract CreatedTimeUtc: DateTime;

type LibraryItemCreatedEvent =
  { Id: Guid;
    Name: string;
    FilePath: string;
    CreatedTimeUtc: DateTime; }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;

type LibraryItemPlayedEvent =
  { Id: Guid;
    CreatedTimeUtc: DateTime; }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;

type SimpleTextAggregateCreatedEvent =
  { Id: Guid;
    CreatedTimeUtc: DateTime;
    Text: string }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;

type SimpleTextAggregateUpdatedEvent =
  { Id: Guid;
    CreatedTimeUtc: DateTime;
    Text: string }
  interface IEvent with
    member x.CreatedTimeUtc = x.CreatedTimeUtc;
    member x.Id = x.Id;