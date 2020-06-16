namespace ReiTunes.Core

open System

[<Interface>]
type IEvent = interface end

type LibraryItemCreatedEvent = {
  ItemId: Guid;
  Name: string;
  FilePath: string;
  CreatedTimeUtc: DateTime;
} with interface IEvent

type LibraryItemPlayedEvent = {
  ItemId: Guid;
} with interface IEvent

//How to do an interface with a value
[<Interface>]
type IInterface =
  abstract Id: Guid

type Record =
  { Id: Guid
    Value1: int }
  interface IInterface with member x.Id = x.Id