using System;
using System.IO;
using System.Threading.Tasks;
using Windows.Storage;

namespace ReiTunes.Helpers {

    public class FileHelper {
        public const string LibraryFolderName = "ReiTunes";

        public async static Task<StorageFolder> CreateLibraryFolderIfDoesntExist() {
            var musicLibrary = KnownFolders.MusicLibrary;
            return await musicLibrary.CreateFolderAsync(LibraryFolderName, CreationCollisionOption.OpenIfExists);
        }

        public static string GetLibraryDbPath() =>
            Path.Combine(ApplicationData.Current.LocalFolder.Path, "library.db");

        public async static Task<StorageFile> GetLibraryDbFileAsync() =>
            await StorageFile.GetFileFromPathAsync(GetLibraryDbPath());
    }
}