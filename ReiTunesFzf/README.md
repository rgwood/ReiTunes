# ReiTunesFzf

A little CLI tool to spit out lines in a format suitable for fzf to consume. For example:

```
reitunes.exe (ReiTunesFzf.exe | fzf --delimiter='\t' --with-nth=2)
```

This opens up fzf with a list of all songs in the local ReiTunes library and then opens the chosen one in ReiTunes.