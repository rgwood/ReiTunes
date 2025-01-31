﻿using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Toolkit.Mvvm.Input;
using ReiTunes.Core;
using ReiTunes.Helpers;
using Serilog;
using Windows.ApplicationModel.Core;
using Windows.ApplicationModel.DataTransfer;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Networking.BackgroundTransfer;
using Windows.Storage;
using Windows.Storage.FileProperties;
using Windows.Storage.Streams;
using Windows.System;
using Windows.UI.Core;
using Windows.UI.Xaml.Media.Imaging;

namespace ReiTunes;

public class PlayerViewModel : Observable
{
    private readonly Uri _cloudBaseUri = new Uri("https://reitunes.blob.core.windows.net/music/");

    private readonly ILogger _logger;
    private readonly Library _library;
    private StorageFolder _libraryFolder;
    private LibraryItem _currentlyPlayingItem;
    private string _downloadStatus = "";
    private bool _downloadInProgress = false;
    private double _downloadPercentFinished = 0;
    private readonly MediaPlayer _mediaPlayer = new MediaPlayer();
    private ObservableCollection<LibraryItem> _libraryItems;
    private ObservableCollection<LibraryItem> _visibleItems;
    private BitmapImage _currentlyPlayingItemThumbnail;

    public event EventHandler ItemsReloaded;

    public LibraryItem CurrentlyPlayingItem
    {
        get { return _currentlyPlayingItem; }
        set { Set(ref _currentlyPlayingItem, value); }
    }

    public ObservableCollection<LibraryItem> LibraryItems
    {
        get { return _libraryItems; }
        set
        {
            Set(ref _libraryItems, value);
            SetVisibleItemsToDefaultSortedAllLibraryItems();
        }
    }

    private void SetVisibleItemsToDefaultSortedAllLibraryItems()
    {
        VisibleItems = new ObservableCollection<LibraryItem>(LibraryItems.OrderByDescending(v => v.CreatedTimeUtc));
    }

    public ObservableCollection<LibraryItem> VisibleItems
    {
        get { return _visibleItems; }
        set { Set(ref _visibleItems, value); }
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

    public double DownloadPercentFinished
    {
        get { return _downloadPercentFinished; }
        set { Set(ref _downloadPercentFinished, value); }
    }

    public AsyncRelayCommand PullEventsCommand { get; }
    public AsyncRelayCommand PushEventsCommand { get; }
    public RelayCommand BookmarkCommand { get; }

    public BitmapImage CurrentlyPlayingItemThumbnail
    {
        get { return _currentlyPlayingItemThumbnail; }
        set { Set(ref _currentlyPlayingItemThumbnail, value); }
    }

    public MediaPlayer MediaPlayer => _mediaPlayer;

    public PlayerViewModel(ILogger logger, Library library)
    {
        _logger = logger;
        _library = library;
        _library.LibraryItemsRebuilt += LoadItemsFromLibrary;
        _mediaPlayer.MediaEnded += MediaPlayer_MediaEnded;
        _mediaPlayer.CommandManager.NextBehavior.EnablingRule = MediaCommandEnablingRule.Always;
        _mediaPlayer.CommandManager.NextReceived += async (_, _) => await PlayRandomBookmark();

        PullEventsCommand = new AsyncRelayCommand(Pull);
        PushEventsCommand = new AsyncRelayCommand(Push);
        BookmarkCommand = new RelayCommand(Bookmark);

        LoadItemsFromLibrary();

    }

    public async Task<bool> TryPlayItem(string aggregateId)
    {
        try
        {
            Guid id = Guid.Parse(aggregateId);
            LibraryItem libraryItemToPlay = LibraryItems.Single(i => i.AggregateId == id);
            await ChangeSource(libraryItemToPlay);
            MediaPlayer.Play();
            return true;
        }
        catch (Exception ex)
        {
            _logger.Error(ex, $"Failed to play item {aggregateId}");
            return false;
        }
    }

    private async void MediaPlayer_MediaEnded(MediaPlayer sender, object args)
    {
        // Breaks with wrong thread exception unless we run on the UI thread.
        // Not sure why this is needed, I assumed I could call the MediaPlayer from background threads
        await CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
            CoreDispatcherPriority.Normal,
            async () => await PlayRandomBookmark());
    }

    private void LoadItemsFromLibrary(object sender = null, EventArgs e = null)
    {
        LibraryItems = new ObservableCollection<LibraryItem>(_library.Items);
    }

    public async Task Initialize()
    {
        _libraryFolder = await FileHelper.CreateLibraryFolderIfDoesntExist();
    }

    private async Task Pull()
    {
        await _library.PullFromServer();
        ItemsReloaded?.Invoke(this, EventArgs.Empty);
    }

    private async Task Push()
    {
        await _library.PushToServer();
    }

    private void Bookmark()
    {
        if (CurrentlyPlayingItem != null)
        {
            CurrentlyPlayingItem.AddBookmark(_mediaPlayer.PlaybackSession.Position);
            _logger.Information("Bookmark created for item {itemId} at {playbackPosition}", CurrentlyPlayingItem.AggregateId, _mediaPlayer.PlaybackSession.Position);
        }
    }

    public async Task FilterItems(string filterString)
    {
        Stopwatch sw = Stopwatch.StartNew();

        if (!string.IsNullOrEmpty(filterString))
        {
            ObservableCollection<LibraryItem> filteredItems = await Task.Run(() => FuzzyMatcher.FuzzyMatch(filterString, LibraryItems));

            _logger.Information("Fuzzy match time: {ElapsedMs}", sw.ElapsedMilliseconds);

            VisibleItems = filteredItems;
        }
        else
        {
            SetVisibleItemsToDefaultSortedAllLibraryItems();
        }

        _logger.Information("Total filter time: {ElapsedMs}", sw.ElapsedMilliseconds);
    }

    public async Task<StorageFile> GetStorageFile(LibraryItem item)
    {
        StorageFolder folder = await GetStorageFolderForItem(item);
        return await folder.TryGetItemAsync(GetFileNameFromFullPath(item.FilePath)) as StorageFile;
    }

    public async Task ShowItemInExplorer(LibraryItem item)
    {
        if (item == null)
            return;

        StorageFolder folder = await GetStorageFolderForItem(item);
        IStorageItem storageItem = await folder.TryGetItemAsync(GetFileNameFromFullPath(item.FilePath));

        if (storageItem != null)
        {
            FolderLauncherOptions options = new FolderLauncherOptions();
            options.ItemsToSelect.Add(storageItem);
            await Launcher.LaunchFolderAsync(folder, options);
        }
    }

    public void Delete(LibraryItem item)
    {
        _library.Delete(item);
    }

    public IEnumerable<string> GetRecentEvents() => _library.GetRecentEvents();

    // given a path like foo/bar/baz.txt, we need to get a StorageFolder for `bar` so we can save to it
    private async Task<StorageFolder> GetStorageFolderForItem(LibraryItem item)
    {
        string[] split = item.FilePath.Split('/');
        Queue<string> directories = new Queue<string>(split.Take(split.Length - 1));

        StorageFolder folder = _libraryFolder;

        while (directories.Any())
        {
            string curr = directories.Dequeue();
            IStorageItem subFolder = await folder.TryGetItemAsync(curr);
            if (subFolder == null)
            {
                folder = await folder.CreateFolderAsync(curr);
            }
            else if (!subFolder.IsOfType(StorageItemTypes.Folder))
            {
                throw new IOException($"Unexpected file found with name '{curr}'");
            }
            else // we found a folder that already exists
            {
                folder = (StorageFolder)subFolder;
            }
        }

        return folder;
    }

    public async Task OpenLibraryFolder()
    {
        await Launcher.LaunchFolderAsync(_libraryFolder);
    }

    private string GetFileNameFromFullPath(string fullPath) => fullPath.Split('/').Last();

    public async Task ChangeSource(LibraryItem libraryItemToPlay)
    {
        if (libraryItemToPlay == null)
            return;

        StorageFile storageItem = await GetStorageFile(libraryItemToPlay);

        if (storageItem == null)
        { // file not found, download it
          // Bad things happen if we try to download a 2nd file while one is already in progress
          // TODO: make this a proper lock
            if (DownloadInProgress)
                return;

            CurrentlyPlayingItem = libraryItemToPlay;
            await DownloadAndStartMusicFile(libraryItemToPlay);
        }
        else if (storageItem.IsOfType(StorageItemTypes.Folder))
        {
            return;
        }
        else if (storageItem.IsOfType(StorageItemTypes.File))
        {
            StorageFile file = storageItem;

            MediaPlaybackItem mediaPlaybackItem = new MediaPlaybackItem(MediaSource.CreateFromStorageFile(file));
            _mediaPlayer.Source = mediaPlaybackItem;
            CurrentlyPlayingItem = libraryItemToPlay;
            await LoadMetadataAndThumbnailForCurrentlyPlayingItem();
        }
    }

    public async Task PlayBookmark(LibraryItem item, Bookmark bookmark)
    {
        if (item != null && bookmark != null)
        {
            if (CurrentlyPlayingItem != item)
            {
                await ChangeSource(item);
            }

            MediaPlayer.PlaybackSession.Position = bookmark.Position;
            MediaPlayer.Play();
        }
    }

    private async Task LoadMetadataAndThumbnailForCurrentlyPlayingItem()
    {
        LibraryItem currentlyPlaying = CurrentlyPlayingItem;
        MediaPlaybackItem mediaPlaybackItem = _mediaPlayer.Source as MediaPlaybackItem;
        if (currentlyPlaying == null || mediaPlaybackItem == null)
            return;

        StorageFile file = await GetStorageFile(currentlyPlaying);
        await UpdateSystemMediaTransportControlsAndThumbnail(currentlyPlaying, mediaPlaybackItem, file);
    }

    public async Task PlayRandomBookmark()
    {
        List<(LibraryItem, Bookmark)> pairs = LibraryItems.SelectMany(i => i.Bookmarks.Select(b => (i, b))).ToList();

        int index = new Random().Next(pairs.Count);

        await PlayBookmark(pairs[index].Item1, pairs[index].Item2);
    }

    private async Task UpdateSystemMediaTransportControlsAndThumbnail(LibraryItem libraryItemToPlay, MediaPlaybackItem mediaPlaybackItem,
        StorageFile fileWithThumbnail = null)
    {
        MediaItemDisplayProperties props = mediaPlaybackItem.GetDisplayProperties();
        props.Type = Windows.Media.MediaPlaybackType.Music;
        props.MusicProperties.Title = libraryItemToPlay.Name;

        if (libraryItemToPlay.Artist != null)
        {
            props.MusicProperties.Artist = libraryItemToPlay.Artist;
        }

        if (libraryItemToPlay.Album != null)
        {
            props.MusicProperties.AlbumTitle = libraryItemToPlay.Album;
        }

        if (fileWithThumbnail != null)
        {
            StorageItemThumbnail thumbnail = await GetAndSetThumbnail(fileWithThumbnail);

            if (thumbnail != null)
            {
                props.Thumbnail = RandomAccessStreamReference.CreateFromStream(thumbnail);
            }
        }

        mediaPlaybackItem.ApplyDisplayProperties(props);
    }

    private async Task<StorageItemThumbnail> GetAndSetThumbnail(StorageFile fileWithThumbnail)
    {
        // TODO: GetThumbnailAsync is unreliable (Windows bug), try PInvoking SHGetFileInfo or IShellItemImageFactory instead 
        StorageItemThumbnail thumbnail = await fileWithThumbnail.GetThumbnailAsync(ThumbnailMode.MusicView, 400, ThumbnailOptions.UseCurrentScale);

        if (thumbnail != null && thumbnail.Type == ThumbnailType.Image)
        {
            BitmapImage img = new BitmapImage();
            img.SetSource(thumbnail);
            CurrentlyPlayingItemThumbnail = img;
            return thumbnail;
        }
        else
        {
            CurrentlyPlayingItemThumbnail = null;
            return null;
        }
    }

    private async Task<MediaSource> DownloadAndStartMusicFile(LibraryItem libraryItemToPlay)
    {
        string fileName = GetFileNameFromFullPath(libraryItemToPlay.FilePath);
        StorageFolder folderToSaveTo = await GetStorageFolderForItem(libraryItemToPlay);


        CurrentlyPlayingItemThumbnail = null;
        Uri downloadUri = GetUri(libraryItemToPlay);

        _logger.Information($"Downloading music file from {downloadUri}");

        StorageFile downloadFile = await folderToSaveTo.CreateFileAsync(fileName);
        DownloadInProgress = true;
        BackgroundDownloader downloader = new BackgroundDownloader();
        DownloadOperation download = downloader.CreateDownload(downloadUri, downloadFile);

        download.IsRandomAccessRequired = true;

        UpdateDownloadStatusOnUiThread(0, "Starting download...");

        Progress<DownloadOperation> progressCallback = new Progress<DownloadOperation>(HandleDownloadProgress);
        Task<DownloadOperation> downloadTask = download.StartAsync().AsTask(progressCallback);
        MediaSource mediaSource = MediaSource.CreateFromDownloadOperation(download);

        MediaPlaybackItem mediaPlaybackItem = new MediaPlaybackItem(mediaSource);

        _mediaPlayer.Source = mediaPlaybackItem;

        await UpdateSystemMediaTransportControlsAndThumbnail(libraryItemToPlay, mediaPlaybackItem);

        await downloadTask;
        DownloadInProgress = false;
        return mediaSource;
    }

    internal Uri GetUri(LibraryItem libraryItemToPlay) => new Uri(_cloudBaseUri, libraryItemToPlay.FilePath);

    private async void HandleDownloadProgress(DownloadOperation download)
    {
        // DownloadOperation.Progress is updated in real-time while the operation is ongoing. Therefore,
        // we must make a local copy so that we can have a consistent view of that ever-changing state
        // throughout this method's lifetime.
        BackgroundDownloadProgress progress = download.Progress;

        double percentageFinished = 100d * progress.BytesReceived / progress.TotalBytesToReceive;

        if (progress.BytesReceived == progress.TotalBytesToReceive)
        {
            DownloadInProgress = false;
            UpdateDownloadStatusOnUiThread(0, "");
            await LoadMetadataAndThumbnailForCurrentlyPlayingItem();
        }
        else
        {
            double mbReceived = progress.BytesReceived / 1024d / 1024d;
            double totalMb = progress.TotalBytesToReceive / 1024d / 1024d;
            string message = $"Downloading: {mbReceived:N1}/{totalMb:N1} MB";
            UpdateDownloadStatusOnUiThread(percentageFinished, message);
        }
    }

    private void UpdateDownloadStatusOnUiThread(double percentageFinished, string message)
    {
        // The ignore variable is to silence an async warning. Seems bad but
        // they did it in the BackgroundTransfer example 🤔
        Windows.Foundation.IAsyncAction ignore = CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
            CoreDispatcherPriority.Normal, () =>
            {
                DownloadStatus = message;
                DownloadPercentFinished = percentageFinished;
            });
    }

    public void CopyUriToClipboard(LibraryItem item)
    {
        DataPackage dataPackage = new() { RequestedOperation = DataPackageOperation.Copy };
        string uri = GetUri(item).ToString();
        dataPackage.SetText(uri);
        Clipboard.SetContent(dataPackage);
    }
}
