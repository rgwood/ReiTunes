using ReiPod.Helpers;
using ReiTunes;
using ReiTunes.Helpers;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Tasks;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.UI.Core;

namespace ReiPod
{
    public class PlayerViewModel : Observable
    {
        private IMediaPlaybackSource _source;
        private string _sourceFileName;

        public IMediaPlaybackSource Source
        {
            get { return _source; }
            set { Set(ref _source, value); }
        }

        public string SourceFileName
        {
            get { return _sourceFileName; }
            set { Set(ref _sourceFileName, value);  }
        }

        private ObservableCollection<FileTreeItem> _fileTreeItems;

        public ObservableCollection<FileTreeItem> FileTreeItems
        {
            get { return _fileTreeItems; }
            set { Set(ref _fileTreeItems, value); }
        }

        public PlayerViewModel()
        {
        }

        public async Task Initialize()
        {
            //var file = await StorageFile.GetFileFromPathAsync(@"C:\Users\reill\Music\AvalanchesJamie.mp3");
            //Source = MediaSource.CreateFromStorageFile(file);
            //SourceFileName = "AvalanchesJamie.mp3";

            var library = await FileHelper.ReiTunesLibrary();
            var libraryFile = await library.TryGetItemAsync("ReiTunesLibrary.txt");

            if(libraryFile == null)
            {
                //todo: download it
                throw new NotImplementedException("Library downloading not ready yet");
            }

            var libraryString = await FileIO.ReadTextAsync((IStorageFile) libraryFile);

            FileTreeItems = FileTreeBuilder.ParseBlobList(libraryString);
        }

        public async void ChangeSource(string fileName)
        {
            var musicLib = await FileHelper.ReiTunesLibrary();
            var storageItem = await musicLib.TryGetItemAsync(fileName);

            if(storageItem == null) // file not found, download it
            {
                throw new NotImplementedException();
            }

            if(storageItem.IsOfType(StorageItemTypes.Folder))
            {
                return;
            }

            if(storageItem.IsOfType(StorageItemTypes.File))
            {
                Source = MediaSource.CreateFromStorageFile((StorageFile)storageItem);
                SourceFileName = fileName;
            }
        }

    }
}
