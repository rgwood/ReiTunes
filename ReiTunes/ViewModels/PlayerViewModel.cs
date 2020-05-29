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
using Windows.ApplicationModel.Core;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Networking.BackgroundTransfer;
using Windows.Storage;
using Windows.UI.Core;

namespace ReiPod
{
    public class PlayerViewModel : Observable
    {
        private IMediaPlaybackSource _source;
        private string _sourceFileName;
        private string _downloadStatus = "placeholder";

        public IMediaPlaybackSource Source
        {
            get { return _source; }
            set { Set(ref _source, value); }
        }

        public string SourceFileName
        {
            get { return _sourceFileName; }
            set { Set(ref _sourceFileName, value); }
        }

        private ObservableCollection<FileTreeItem> _fileTreeItems;

        public ObservableCollection<FileTreeItem> FileTreeItems
        {
            get { return _fileTreeItems; }
            set { Set(ref _fileTreeItems, value); }
        }

        public string DownloadStatus
        {
            get { return _downloadStatus; }
            set { Set(ref _downloadStatus, value); }
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

            if (libraryFile == null)
            {
                //todo: download it
                throw new NotImplementedException("Library downloading not ready yet");
            }

            var libraryString = await FileIO.ReadTextAsync((IStorageFile)libraryFile);

            FileTreeItems = FileTreeBuilder.ParseBlobList(libraryString);
        }

        public async void ChangeSource(string fileName)
        {
            var cloudLibraryBaseUri = new Uri("https://reitunes.blob.core.windows.net/reitunes/");


            var musicLib = await FileHelper.ReiTunesLibrary();
            var storageItem = await musicLib.TryGetItemAsync(fileName);

            if (storageItem == null) // file not found, download it
            {
                var downloadUri = new Uri(cloudLibraryBaseUri, fileName);

                var downloadFile = await musicLib.CreateFileAsync(fileName);
                BackgroundDownloader downloader = new BackgroundDownloader();
                DownloadOperation download = downloader.CreateDownload(downloadUri, downloadFile);
                Progress<DownloadOperation> progressCallback = new Progress<DownloadOperation>(HandleDownloadProgress);
                await download.StartAsync().AsTask(progressCallback);
                storageItem = downloadFile;
            }

            if (storageItem.IsOfType(StorageItemTypes.Folder))
            {
                return;
            }

            if (storageItem.IsOfType(StorageItemTypes.File))
            {
                Source = MediaSource.CreateFromStorageFile((StorageFile)storageItem);
                SourceFileName = fileName;
            }
        }

        private void HandleDownloadProgress(DownloadOperation download)
        {
            // DownloadOperation.Progress is updated in real-time while the operation is ongoing. Therefore,
            // we must make a local copy so that we can have a consistent view of that ever-changing state
            // throughout this method's lifetime.
            BackgroundDownloadProgress progress = download.Progress;

            string message = "";
            if(progress.BytesReceived == progress.TotalBytesToReceive)
            {
                message = "Download finished";
            }
            else
            {
                var kbReceived = progress.BytesReceived / 1024;
                var totalKb = progress.TotalBytesToReceive / 1024;
                message = $"{kbReceived} / {totalKb}";
            }

            // The ignore variable is to silence an async warning. Seems bad but
            // they did it in the BackgroundTransfer example 🤔
            var ignore = CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
                CoreDispatcherPriority.Normal, () =>
                {
                    DownloadStatus = message;
                });
        }

    }
}
