using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Windows.Storage;

namespace ReiTunes.Helpers
{
    public class FileHelper
    {
        public const string LibraryFolderName = "ReiTunes";

        public async static Task<StorageFolder> CreateLibraryFolderIfDoesntExist()
        {
            var musicLibrary = KnownFolders.MusicLibrary;
            return await musicLibrary.CreateFolderAsync(LibraryFolderName, CreationCollisionOption.OpenIfExists);
        }
    }
}
