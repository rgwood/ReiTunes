I've been trying to tidy up ReiTunes.Blazor and I am not particularly enjoying it. Maybe I can rewrite the core event sourcing functionality in Rust and keep it backwards-compatible with the existing database format?

Everything in here is extremely WIP.

## TODO

- [ ] Figure out how to map the events table rows to Rust idiomatically. Can't really do interfaces like in C#
- [ ] Create LibraryItem and Bookmark structs
- [ ] Write some tests for applying events to a single node
- [ ] Port C# tests for multiple nodes / syncing