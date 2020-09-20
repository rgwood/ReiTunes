# ReiTunes

My personal music library system, with a modern Windows client and Linux server.

![Dark UI](https://res.cloudinary.com/reilly-wood/image/upload/v1600566175/reitunes/dark.jpg)
![Light UI](https://res.cloudinary.com/reilly-wood/image/upload/v1600566175/reitunes/light.jpg)

## Why?

I have 3 priorities for my music collection:

1. My collection needs to last forever (or at least until I kick the bucket) 
2. It should integrate well with music podcasts and online series
3. It should have a good native Windows app that can sync across multiple devices and also operate offline

Those aren't really met by any existing music services. I don't know if any given streaming service will be around next year, let alone 40 years from now. iTunes Match is OK as a service but the Windows client is not.

So, like any sane person would do, I wrote my own app+service.

## What?

The Windows client is a modern UWP application using WinUI, MSIX sideloading, WinRT APIs and the AppContainer sandbox. It can stream or download music from my personal collection, and it has a fast fuzzy-find real-time search.

On the server side, an ASP.NET Core web API running on a Linux server acts as a central sync point for library metadata. Music files are stored in generic cloud object storage and accessible over HTTPS.

Library metadata changes are treated as events; they are serialized to JSON and stored in SQLite locally immediately, then pushed to the server asynchronously later. You can think of the events like Git commits.

The entire library is rebuilt from events on launch. There are plenty of easy optimizations to be made here; benchmarks suggest that they will not be necessary until I approach a few hundred thousand events.

SQLite and ASP.NET Core allow for in-memory distributed integration tests that run in NCrunch automatically in milliseconds. This is wonderful for development.

## Acknowledgments

The library metadata synchronization approach is heavily influenced by [Building offline-first web and mobile apps using event-sourcing](https://flpvsk.com/blog/2019-07-20-offline-first-apps-event-sourcing/) by Andrey Salomatin.

ReiTunes was partially motivated by [Tom MacWright's excellent post about his own music library](https://macwright.com/2020/01/27/my-music-library.html).

## Disclaimers

This is provided with no promises around support or features. Happy to chat about feature ideas, but I am writing this for myself, for fun.

Music piracy is bad; you should buy your music from a reputable source like [Bandcamp](https://bandcamp.com/).
