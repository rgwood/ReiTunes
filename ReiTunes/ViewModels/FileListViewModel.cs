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

namespace ReiPod
{
    public class FileListViewModel : Observable
    {

        private ObservableCollection<FileTreeItem> _fileTreeItems;

        public ObservableCollection<FileTreeItem> FileTreeItems
        {
            get { return _fileTreeItems; }
            set { Set(ref _fileTreeItems, value);  }
        }

        public FileListViewModel()
        {
        }

        public async Task Initialize()
        {
            FileTreeItems = FileTreeItemBuilder.GetSampleData();
        }
    }
}
