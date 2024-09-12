This is a Rust + web UI port of ReiTunes. It can view+edit+play back audio using a local library database and audio files in cloud storage.

## Motivation/background

I'm giving up on ReiTunes.Blazor; I'm not particularly enjoying working in .NET these days.

I want to be in Rust, and the easiest way to do that is with web UI. The web platform already has a ton of useful stuff like an <audio> player that can handle seeking etc. 

Someday it might be fun to explore something like Iced for the GUI but that will involve a lot of work. Would need to roll my own player widget and a lot of code for audio, files, network access etc.

## Future work

This is entirely single-node right now. I'm not sure whether to forge ahead with the original multi-node offline-first vision. It still appeals to me, but:

1. I'm not 100% offline very often
2. A web UI makes it especially tempting to just have a single central server
   1. If I'm already paying the complexity tax (HTTP requests, split brain thing) for web... maybe I should take advantage of that instead of treating this like a normal desktop app?

Still need to:
- implement better bookmark functionality (adding bookmarks, at least)
- figure out a workflow for adding songs (another API that gets called from the Azure Function, probably)
