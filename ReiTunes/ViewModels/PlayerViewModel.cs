using Microsoft.Toolkit.Uwp.Helpers;
using ReiTunes.Configuration;
using ReiTunes.Helpers;
using ReiTunes;
using ReiTunes.Core.Helpers;
using ReiTunes.Helpers;
using ReiTunes.Services;
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
using Serilog;

namespace ReiTunes
{
    public class PlayerViewModel : Observable
    {
        private Uri _cloudBaseUri = new Uri("https://reitunes.blob.core.windows.net/reitunes/");
        private const string _libraryFileName = "ReiTunesLibrary.txt";

        private readonly ILogger _logger;

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
            //var file = await StorageFile.GetFileFromPathAsync(@"C:\Users\reill\Music\AvalanchesJamie.mp3");
            //Source = MediaSource.CreateFromStorageFile(file);
            //SourceFileName = "AvalanchesJamie.mp3";

            var library = await FileHelper.CreateLibraryFolderIfDoesntExist();
            var libraryFile = await library.TryGetItemAsync("ReiTunesLibrary.txt");

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
            var libraryFileUri = new Uri(_cloudBaseUri, _libraryFileName);
            _logger.Information("Downloading library file from {libraryUri}", libraryFileUri);
            var libraryContents = await httpService.GetStringAsync(libraryFileUri);
            _logger.Information("Finished downloading library file");
            var musicLib = await FileHelper.CreateLibraryFolderIfDoesntExist();
            return await musicLib.WriteTextToFileAsync(libraryContents, 
                _libraryFileName, CreationCollisionOption.ReplaceExisting);
        }

        private async Task LoadLibraryFile(IStorageItem libraryFile)
        {
            var libraryString = await FileIO.ReadTextAsync((StorageFile)libraryFile);
            FileTreeItems = FileTreeBuilder.ParseBlobList(libraryString);
        }

        public async void ChangeSource(string filePath)
        {
            var musicLib = await FileHelper.CreateLibraryFolderIfDoesntExist();

            //todo: get to the right folder
            var split = filePath.Split('/');
            var directories = new Queue<string>(split.Take(split.Length - 1));
            var fileName = split.Last();

            var folder = musicLib;

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

    }
}
