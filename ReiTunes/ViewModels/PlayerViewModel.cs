using Microsoft.Toolkit.Uwp.Helpers;
using ReiTunes.Configuration;
using ReiTunes.Helpers;
using ReiTunes.Services;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Windows.ApplicationModel.Core;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Networking.BackgroundTransfer;
using Windows.Storage;
using Windows.UI.Core;
using Serilog;

namespace ReiTunes
{
    public class PlayerViewModel : Observable
    {
        private Uri _cloudBaseUri = new Uri("https://reitunes.blob.core.windows.net/music/");
        private const string _libraryFileName = "ReiTunesLibrary.txt";
        private Uri _libraryFileUri = new Uri("https://reitunes.blob.core.windows.net/library/" + _libraryFileName);

        private readonly ILogger _logger;

        private StorageFolder _libraryFolder;
        private IMediaPlaybackSource _source;
        private string _sourceFileName;
        private string _downloadStatus = "";
        private bool _downloadInProgress = false;
        
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

        public bool DownloadInProgress
        {
            get { return _downloadInProgress; }
            set { Set(ref _downloadInProgress, value); }
        }

        public PlayerViewModel(ILogger logger)
        {
            _logger = logger;
        }

        public async Task Initialize()
        {
            _libraryFolder = await FileHelper.CreateLibraryFolderIfDoesntExist();
            var libraryFile = await _libraryFolder.TryGetItemAsync("ReiTunesLibrary.txt");

            if (libraryFile == null)
            {
                _logger.Information("Library file not found, downloading...");
                libraryFile = await DownloadLibraryFile();
            }

            await LoadLibraryFile(libraryFile);
        }

        public async Task DownloadAndLoadLibraryFile()
        {
            var libraryFile = await DownloadLibraryFile();
            await LoadLibraryFile(libraryFile);
        }

        private async Task<StorageFile> DownloadLibraryFile()
        {
            var httpService = ServiceLocator.Current.GetService<HttpDataService>();
            _logger.Information("Downloading library file from {libraryUri}", _libraryFileUri);
            var libraryContents = await httpService.GetStringAsync(_libraryFileUri);
            _logger.Information("Finished downloading library file");
            return await _libraryFolder.WriteTextToFileAsync(libraryContents, 
                _libraryFileName, CreationCollisionOption.ReplaceExisting);
        }

        private async Task LoadLibraryFile(IStorageItem libraryFile)
        {
            var libraryString = await FileIO.ReadTextAsync((StorageFile)libraryFile);
            FileTreeItems = FileTreeBuilder.ParseBlobList(libraryString);
        }

        public async void ChangeSource(string filePath)
        {
            if (filePath == null)
                return;

            // given a path like foo/bar/baz.txt, we need to get a StorageFolder for `bar` so we can save to it
            var split = filePath.Split('/');
            var directories = new Queue<string>(split.Take(split.Length - 1));
            var fileName = split.Last();

            var folder = _libraryFolder;

            while(directories.Any())
            {
                var curr = directories.Dequeue();
                var subFolder = await folder.TryGetItemAsync(curr);
                if(subFolder == null)
                {
                    folder = await folder.CreateFolderAsync(curr);
                }
                else if(!subFolder.IsOfType(StorageItemTypes.Folder))
                {
                    throw new IOException($"Unexpected file found with name '{curr}'");
                }
                else // we found a folder that already exists
                {
                    folder = (StorageFolder) subFolder;
                }
            }

            var storageItem = await folder.TryGetItemAsync(fileName);

            if (storageItem == null) // file not found, download it
            {
                // Bad things happen if we try to download a 2nd file while one is already in progress
                // TODO: make this a proper lock
                if (DownloadInProgress)
                    return;

                StorageFile downloadFile = await DownloadMusicFile(filePath, fileName, folder);
                storageItem = downloadFile;
            }

            if (storageItem.IsOfType(StorageItemTypes.Folder))
            {
                return;
            }

            if (storageItem.IsOfType(StorageItemTypes.File))
            {
                Source = MediaSource.CreateFromStorageFile((StorageFile)storageItem);
                SourceFileName = filePath;
            }
        }

        private async Task<StorageFile> DownloadMusicFile(string relativeFilePath, string fileName, StorageFolder folderToSaveTo)
        {
            _logger.Information("Downloading music file {filePath}", relativeFilePath);
            var downloadUri = new Uri(_cloudBaseUri, relativeFilePath);
            var downloadFile = await folderToSaveTo.CreateFileAsync(fileName);
            DownloadInProgress = true;
            BackgroundDownloader downloader = new BackgroundDownloader();
            DownloadOperation download = downloader.CreateDownload(downloadUri, downloadFile);
            Progress<DownloadOperation> progressCallback = new Progress<DownloadOperation>(HandleDownloadProgress);
            await download.StartAsync().AsTask(progressCallback);
            DownloadInProgress = false;
            return downloadFile;
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
                var mbReceived = progress.BytesReceived / 1024d / 1024d;
                var totalMb = progress.TotalBytesToReceive / 1024d / 1024d;
                message = $"Downloading: {mbReceived:N1} mb / {totalMb:N1} mb";
            }

            // The ignore variable is to silence an async warning. Seems bad but
            // they did it in the BackgroundTransfer example 🤔
            var ignore = CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
                CoreDispatcherPriority.Normal, () =>
                {
                    DownloadStatus = message;
                });
        }

        //Todo: cache this if it gets slow
        public IEnumerable<FileTreeItem> FlattenedFileList()
        {
            var ret = new List<FileTreeItem>();
            foreach (var item in FileTreeItems)
            {
                ret.AddRange(FlattenFileTreeItem(item));
            }

            return ret;
        }

        //if it's a folder, return its contents. If it's a file, just return it
        private IEnumerable<FileTreeItem> FlattenFileTreeItem(FileTreeItem item)
        {
            var ret = new List<FileTreeItem>();

            switch (item.Type)
            {
                case FileTreeItemType.Folder:
                    foreach (var child in item.Children)
                    {
                        ret.AddRange(FlattenFileTreeItem(child));
                    }
                    break;
                case FileTreeItemType.File:
                    ret.Add(item);
                    break;
                default:
                    throw new NotSupportedException();
            }

            return ret;
        }

    }
}
