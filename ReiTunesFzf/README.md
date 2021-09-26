# ReiTunesFzf

A little CLI tool to spit out lines in a format suitable for fzf to consume. For example:

```
reitunes.exe (ReiTunesFzf.exe | fzf --delimiter='\t' --with-nth=2)
```

This opens up fzf with a list of all songs in the local ReiTunes library and then opens the chosen one in ReiTunes.

## TODO

Figure out how to get the full path of the local appdata folder. library.db is normally stored here:

> AppData\Local\Packages\2b3c53fd-b804-4e1e-b26c-cae302ea1108_hmppzwgz807yp\LocalState

Not clear how to get that full path in a way that will work across machines and installs.