# ReiTunes

My personal music library system, with clients and a server.

![Dark UI](https://res.cloudinary.com/reilly-wood/image/upload/v1608417001/reitunes/dark.jpg)
![Light UI](https://res.cloudinary.com/reilly-wood/image/upload/v1608417001/reitunes/light.jpg)

## Why?

When I started, I had 3 priorities for my music collection:

1. My collection needs to last forever (or at least until I kick the bucket) 
2. It should integrate well with music podcasts and online series
3. It should have a good native Windows app that can sync across multiple devices and also operate offline

Those aren't really met by any existing music services. I don't know if any given streaming service will be around next year, let alone 40 years from now. iTunes Match is OK as a service but the Windows client is not.

So I decided to write my own app+service. How hard could it be? Well, 257 commits later... 😬

## What?

The Windows client is a UWP application. It can stream or download music from my personal collection, and it has a fast fuzzy-find search. There's also a cross-platform web UI client using Blazor Server but it's not quite as full-featured.

On the server side, a web API acts as a central sync point for library metadata. Music files are stored in cloud object storage and accessible over HTTPS.

Library metadata changes are treated as events; they are serialized to JSON and stored in SQLite locally immediately, then pushed to the server asynchronously later. You can think of the events like Git commits.

The entire library is rebuilt from events on launch. There are plenty of easy optimizations to be made here; benchmarks suggest that they will not be necessary for a long time.

SQLite and ASP.NET Core allow for in-memory distributed integration tests that run in NCrunch automatically in milliseconds. This is wonderful for development.

## Acknowledgments

The library synchronization approach is heavily influenced by [Building offline-first web and mobile apps using event-sourcing](https://flpvsk.com/blog/2019-07-20-offline-first-apps-event-sourcing/) by Andrey Salomatin.

ReiTunes was partially motivated by [Tom MacWright's excellent post about his own music library](https://macwright.com/2020/01/27/my-music-library.html).

## Disclaimers

This is provided with no promises around support or features. You will need to run your own server and bring your own music. Happy to chat about feature ideas, but I am writing this for myself, for fun.

Music piracy is bad; you should buy your music from a reputable source like [Bandcamp](https://bandcamp.com/).
