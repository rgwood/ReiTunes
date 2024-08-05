I've been trying to tidy up ReiTunes.Blazor and I am not particularly enjoying it. Maybe I can rewrite the core event sourcing functionality in Rust and keep it backwards-compatible with the existing database format?

Everything in here is extremely WIP.

## TODO

- [x] Read a row from the DB into a struct w/ a string Serialized column
- [x] Make an event enum
- [x] Figure out how to map the events table rows to Rust idiomatically. Can't really do interfaces like in C#
- [x] Create LibraryItem and Bookmark structs
- [ ] Implement editing.
- [ ] Write some tests for applying events to a single node
- [ ] Port C# tests for multiple nodes / syncing

## Thoughts

There's a ton of super redundant data in the Serialized column... how far do I want to go to maintain backwards compatibility?
If I redesign things I will need to replace *everything* in C#. Server and serverless function. But maybe that's OK.
Leaning toward redesigning and simplifying. Ignore unused fields in the serialized column.


# Sunday plan of attack

- Implement LibraryItemCreated and LibraryItemPlayed
    - Add an apply() fn
    - Add a struct for LibraryItem
- Get Aider to implement the rest
- Get Aider to write a bunch of tests