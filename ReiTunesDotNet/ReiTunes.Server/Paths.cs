﻿namespace ReiTunes.Server;

internal static class Paths
{

    internal static string ApplicationDataDirectoryPath => Environment.OSVersion.Platform switch
    {
        PlatformID.Win32NT => @"C:\ReiTunes\",
        // TODO: this should probably be user-specific? Maybe ~/.local/share/reitunes/ as per the XDG
        PlatformID.Unix => @"/var/reitunes/",
        _ => throw new Exception($"Unexpected platform  '{Environment.OSVersion.Platform}'")
    };

    internal static string LibraryDbPath => Path.Combine(ApplicationDataDirectoryPath, "library.db");
    internal static string LogFilePath => Path.Combine(ApplicationDataDirectoryPath, "ReiTunes_Log_.txt");
}
