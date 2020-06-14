namespace ReiTunes.Records

open System

[<Interface>]
type IEvent = interface end

type LibraryItemCreatedEvent = {
  ItemId: Guid;
  FilePath: string;
} with interface IEvent