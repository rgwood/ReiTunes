# ReiTunes track grid

The library uses a compact track grid with search and playback controls above it. Songs and DJ sets share the same rows.

At 1440×900, the grid starts 78px from the top and shows 32 complete tracks in 24px rows. There is no permanent sidebar, heading area, artwork or view selector.

Search matches track names, artists, albums and bookmark labels. Focus it with `/`, Ctrl/Cmd+K or Ctrl/Cmd+F. Filters such as `artist:"Four Tet"` and `album:"Rounds"` still work.

The grid keeps sortable, resizable columns, metadata editing and right-click actions. Playlists, bookmarks and the queue open as optional panels. The collection filter includes favourites, recently added tracks and unplayed tracks.

Import music accepts files, folders and links. Review selected files before importing; retry failed files individually. You can also drop audio files onto the library. Link submissions queue a download.

Next saved moment advances to the next bookmark using the live playback position and preserves manually queued tracks. Browser and Sonos playback use the existing controls.

The settings gear opens Appearance and playback output settings. Pick separate light and dark themes from eight families: Neutral, Solarized, Catppuccin, Gruvbox, Nord, Dracula, Tokyo Night and Rosé Pine. System mode follows the OS and activates the corresponding theme, including changes while the app is open; Light and Dark override it. Both theme choices and the mode are saved in this browser and sync between open tabs. Existing single-theme preferences carry over to both choices.

No backend, database schema or application dependency changes were needed.

The production frontend build, 31 unit tests and 44 browser tests pass. Browser checks include density, search, imports, queue preservation, playlists, Sonos controls and stale playback events. Theme checks cover all 16 light/dark palettes, text contrast, independent light and dark preferences, live system changes, preference migration, persistence, invalid settings, blocked storage and keyboard focus. Existing unrelated repository-wide lint errors remain.
