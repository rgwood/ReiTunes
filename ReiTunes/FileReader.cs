using System;
using System.IO;
using System.Threading.Tasks;

namespace ReiTunes;

public class FileReader
{
    public const string MusicLibraryFileName = "reiTunesMusicLibrary.txt";

    public static async Task<bool> MusicLibraryFileExists() => await FileExists(MusicLibraryFileName);

    public static async Task<bool> FileExists(string fileName)
    {
        Windows.Storage.StorageFolder localFolder = Windows.Storage.ApplicationData.Current.LocalFolder;

        try
        {
            await localFolder.GetFileAsync(fileName);
        }
        catch (FileNotFoundException)
        {
            return false;
        }

        return true;
    }
}
