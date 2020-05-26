using ReiTunes;
using ReiTunes.Helpers;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
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
            var file = await StorageFile.GetFileFromPathAsync(@"C:\Users\reill\Music\AvalanchesJamie.mp3");
            Source = MediaSource.CreateFromStorageFile(file);
            SourceFileName = "AvalanchesJamie.mp3";
            FileTreeItems = FileTreeItemBuilder.GetSampleData();
        }

        public async void ChangeSource(string fileName)
        {
            var file = await StorageFile.GetFileFromPathAsync(@"C:\Users\reill\Music\" + fileName);
            Source = MediaSource.CreateFromStorageFile(file);
            SourceFileName = fileName;
        }

    }
}
