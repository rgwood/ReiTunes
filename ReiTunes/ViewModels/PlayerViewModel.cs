using Microsoft.Toolkit.Mvvm.Input;
using Microsoft.Toolkit.Uwp.Helpers;
using ReiTunes.Configuration;
using ReiTunes.Core;
using ReiTunes.Helpers;
using ReiTunes.Services;
using Serilog;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Windows.ApplicationModel.Core;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Networking.BackgroundTransfer;
using Windows.Storage;
using Windows.System;
using Windows.UI.Core;
using Windows.UI.Xaml.Controls;
using Windows.Storage.FileProperties;
using Windows.UI.Xaml.Media.Imaging;
using Windows.Storage.Streams;

namespace ReiTunes {

    public class PlayerViewModel : Observable {
        private Uri _cloudBaseUri = new Uri("https://reitunes.blob.core.windows.net/music/");

        private readonly ILogger _logger;
        private readonly Library _library;
        private StorageFolder _libraryFolder;
        private IMediaPlaybackSource _source;
        private LibraryItem _currentlyPlayingItem;
        private string _downloadStatus = "";
        private bool _downloadInProgress = false;
        private double _downloadPercentFinished = 0;
        private ObservableCollection<LibraryItem> _libraryItems;
        private ObservableCollection<LibraryItem> _visibleItems;
        private BitmapImage _currentlyPlayingItemThumbnail;

        public IMediaPlaybackSource Source {
            get { return _source; }
            set { Set(ref _source, value); }
        }

        public LibraryItem CurrentlyPlayingItem {
            get { return _currentlyPlayingItem; }
            set { Set(ref _currentlyPlayingItem, value); }
        }

        public ObservableCollection<LibraryItem> LibraryItems {
            get { return _libraryItems; }
            set {
                Set(ref _libraryItems, value);
                VisibleItems = new ObservableCollection<LibraryItem>(value);
            }
        }

        public ObservableCollection<LibraryItem> VisibleItems {
            get { return _visibleItems; }
            set { Set(ref _visibleItems, value); }
        }

        public string DownloadStatus {
            get { return _downloadStatus; }
            set { Set(ref _downloadStatus, value); }
        }

        public bool DownloadInProgress {
            get { return _downloadInProgress; }
            set { Set(ref _downloadInProgress, value); }
        }

        public double DownloadPercentFinished {
            get { return _downloadPercentFinished; }
            set { Set(ref _downloadPercentFinished, value); }
        }

        public AsyncRelayCommand PullEventsCommand { get; }
        public AsyncRelayCommand PushEventsCommand { get; }

        public BitmapImage CurrentlyPlayingItemThumbnail {
            get { return _currentlyPlayingItemThumbnail; }
            set { Set(ref _currentlyPlayingItemThumbnail, value); }
        }

        public PlayerViewModel(ILogger logger, Library library) {
            _logger = logger;
            _library = library;
            _library.LibraryItemsRebuilt += LoadItemsFromLibrary;

            PullEventsCommand = new AsyncRelayCommand(Pull);
            PushEventsCommand = new AsyncRelayCommand(Push);

            LoadItemsFromLibrary();
        }

        private void LoadItemsFromLibrary(object sender = null, EventArgs e = null) {
            LibraryItems = new ObservableCollection<LibraryItem>(_library.Items);
        }

        public async Task Initialize() {
            _libraryFolder = await FileHelper.CreateLibraryFolderIfDoesntExist();

            //var libraryFile = await _libraryFolder.TryGetItemAsync("ReiTunesLibrary.txt");

            //if (libraryFile == null) {
            //    _logger.Information("Library file not found, downloading...");
            //    libraryFile = await DownloadLibraryFile();
            //}

            //await LoadLibraryFile(libraryFile);
        }

        public async Task Pull() {
            await _library.PullFromServer();
        }

        public async Task Push() {
            await _library.PushToServer();
        }

        public async Task FilterItems(string filterString) {
            var sw = Stopwatch.StartNew();

            var filteredItems = await Task.Run(() => FuzzyMatcher.FuzzyMatch(filterString, LibraryItems));

            _logger.Information("Fuzzy match time: {ElapsedMs}", sw.ElapsedMilliseconds);

            VisibleItems = filteredItems;
            _logger.Information("Total filter time: {ElapsedMs}", sw.ElapsedMilliseconds);
        }

        private async Task LoadLibraryFile(IStorageItem libraryFile) {
            var libraryString = await FileIO.ReadTextAsync((StorageFile)libraryFile);
            LibraryItems = LibraryFileParser.ParseBlobList(libraryString);
        }

        public async void ChangeSource(LibraryItem libraryItemToPlay) {
            if (libraryItemToPlay == null)
                return;

            var filePath = libraryItemToPlay.FilePath;

            // given a path like foo/bar/baz.txt, we need to get a StorageFolder for `bar` so we can save to it
            var split = filePath.Split('/');
            var directories = new Queue<string>(split.Take(split.Length - 1));
            var fileName = split.Last();

            var folder = _libraryFolder;

            while (directories.Any()) {
                var curr = directories.Dequeue();
                var subFolder = await folder.TryGetItemAsync(curr);
                if (subFolder == null) {
                    folder = await folder.CreateFolderAsync(curr);
                }
                else if (!subFolder.IsOfType(StorageItemTypes.Folder)) {
                    throw new IOException($"Unexpected file found with name '{curr}'");
                }
                else // we found a folder that already exists
                {
                    folder = (StorageFolder)subFolder;
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

            if (storageItem.IsOfType(StorageItemTypes.Folder)) {
                return;
            }

            if (storageItem.IsOfType(StorageItemTypes.File)) {
                var file = (StorageFile)storageItem;
                var mediaPlaybackItem = new MediaPlaybackItem(MediaSource.CreateFromStorageFile(file));

                Source = mediaPlaybackItem;

                CurrentlyPlayingItem = libraryItemToPlay;
                MediaItemDisplayProperties props = mediaPlaybackItem.GetDisplayProperties();
                props.Type = Windows.Media.MediaPlaybackType.Music;
                props.MusicProperties.Title = libraryItemToPlay.Name;

                if (libraryItemToPlay.Artist != null) {
                    props.MusicProperties.Artist = libraryItemToPlay.Artist;
                }

                if (libraryItemToPlay.Album != null) {
                    props.MusicProperties.AlbumTitle = libraryItemToPlay.Album;
                }

                var thumbnail = await file.GetThumbnailAsync(ThumbnailMode.MusicView, 400, ThumbnailOptions.UseCurrentScale);

                if (thumbnail != null && thumbnail.Type == ThumbnailType.Image) {
                    props.Thumbnail = RandomAccessStreamReference.CreateFromStream(thumbnail);
                    var img = new BitmapImage();
                    img.SetSource(thumbnail);
                    CurrentlyPlayingItemThumbnail = img;
                }
                else {
                    CurrentlyPlayingItemThumbnail = null;
                }

                mediaPlaybackItem.ApplyDisplayProperties(props);
            }
        }

        private async Task<StorageFile> DownloadMusicFile(string relativeFilePath, string fileName, StorageFolder folderToSaveTo) {
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

        private void HandleDownloadProgress(DownloadOperation download) {
            // DownloadOperation.Progress is updated in real-time while the operation is ongoing. Therefore,
            // we must make a local copy so that we can have a consistent view of that ever-changing state
            // throughout this method's lifetime.
            BackgroundDownloadProgress progress = download.Progress;

            double percentageFinished = 100d * progress.BytesReceived / progress.TotalBytesToReceive;

            string message = "";
            if (progress.BytesReceived == progress.TotalBytesToReceive) {
                message = "Download finished";
            }
            else {
                var mbReceived = progress.BytesReceived / 1024d / 1024d;
                var totalMb = progress.TotalBytesToReceive / 1024d / 1024d;
                message = $"Downloading: {mbReceived:N1}/{totalMb:N1} MB";
            }

            // The ignore variable is to silence an async warning. Seems bad but
            // they did it in the BackgroundTransfer example 🤔
            var ignore = CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
                CoreDispatcherPriority.Normal, () => {
                    DownloadStatus = message;
                    DownloadPercentFinished = percentageFinished;
                });
        }
    }
}