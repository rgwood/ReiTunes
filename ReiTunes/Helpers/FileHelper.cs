using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Windows.Storage;

namespace ReiPod.Helpers
{
    public class FileHelper
    {
        private const string LibraryFolderName = "ReiTunes";
        public async static Task<StorageFolder> ReiTunesLibrary()
        {
            var musicLibrary = KnownFolders.MusicLibrary;
            return await musicLibrary.CreateFolderAsync(LibraryFolderName, CreationCollisionOption.OpenIfExists);
        }
    }
}
