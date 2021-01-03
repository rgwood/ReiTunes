using ReiTunes.Configuration;
using ReiTunes.Core;
using ReiTunes.Helpers;
using ReiTunes.Views;
using System;
using System.Linq;
using System.Reactive.Linq;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.Foundation;
using Windows.Media.Playback;
using Windows.System;
using Windows.UI.Text;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Documents;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Media.Animation;
using Windows.UI.Xaml.Navigation;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=402352&clcid=0x409

namespace ReiTunes {

    /// <summary>
    /// The main UI of ReiTunes, a simple music player
    /// </summary>
    public sealed partial class Player : Page {
        public PlayerViewModel ViewModel { get; }

        private bool _dataGridIsEditing;
        private bool _thumbNailIsRotating;
        private Storyboard _thumbnailStoryboard = new Storyboard();

        public string MsixVersion { get; }

        public Player() {
            this.InitializeComponent();

            var ver = Package.Current.Id.Version;
            MsixVersion = $"v{ver.Major}.{ver.Minor}.{ver.Build}.{ver.Revision}";

            ApplicationView.GetForCurrentView().SetPreferredMinSize(new Size(200, 155));
            ViewModel = ServiceLocator.Current.GetService<PlayerViewModel>();
            SetUpKeyboardAccelerators();
            ViewModel.PropertyChanged += ViewModel_PropertyChanged;
            // when items change underneath us, refilter them if applicable
            ViewModel.ItemsReloaded += async (_, _) => await FilterVMUsingFilterBoxText();

            musicPlayer.SetMediaPlayer(ViewModel.MediaPlayer);

            SetUpThumbnailAnimation();

            // without throttling, the DataGrid can't refresh fast enough to keep up with typing
            // I don't love this solution because it adds delay to the first keystroke
            // TODO: better Rx query that returns right away.
            var textChangedSequence =
                System.Reactive.Linq.Observable.FromEventPattern<TextChangedEventArgs>(FilterBox,
                nameof(FilterBox.TextChanged))
                .Throttle(TimeSpan.FromMilliseconds(300))
                .ObserveOnCoreDispatcher()
                .Subscribe(async a => await FilterVMUsingFilterBoxText());
        }

        private void ViewModel_PropertyChanged(object sender, System.ComponentModel.PropertyChangedEventArgs e) {
            if (e.PropertyName == nameof(ViewModel.CurrentlyPlayingItem)) {
                UpdateCurrentlyPlayingText();
            }
        }

        private void UpdateCurrentlyPlayingText() {
            if (ViewModel.CurrentlyPlayingItem is null) {
                return;
            }

            CurrentlyPlayingItemDescription.Inlines.Clear();

            CurrentlyPlayingItemDescription.Inlines.Add(new Run() { Text = ViewModel.CurrentlyPlayingItem?.Name });

            // doing this all in C# because these kinds of conditionals are a PITA in XAML
            // Runs don't have a visibility property
            if (!string.IsNullOrEmpty(ViewModel.CurrentlyPlayingItem?.Artist)) {
                CurrentlyPlayingItemDescription.Inlines.Add(new Run() { Text = " by ", FontWeight = FontWeights.Light });
                CurrentlyPlayingItemDescription.Inlines.Add(new Run() { Text = ViewModel.CurrentlyPlayingItem?.Artist });
            }

            if (!string.IsNullOrEmpty(ViewModel.CurrentlyPlayingItem?.Album)) {
                CurrentlyPlayingItemDescription.Inlines.Add(new Run() { Text = " on ", FontWeight = FontWeights.Light });
                CurrentlyPlayingItemDescription.Inlines.Add(new Run() { Text = ViewModel.CurrentlyPlayingItem?.Album });
            }
        }

        private void ToggleMediaPlaybackState() {
            var mediaPlayer = musicPlayer.MediaPlayer;
            var currState = mediaPlayer.PlaybackSession.PlaybackState;
            if (currState == MediaPlaybackState.Playing) {
                mediaPlayer.Pause();
            }
            else if (currState == MediaPlaybackState.Paused || currState == MediaPlaybackState.None) {
                mediaPlayer.Play();
            }
        }

        protected async override void OnNavigatedTo(NavigationEventArgs e) {
            base.OnNavigatedTo(e);
            await ViewModel.Initialize();
        }

        private async void OpenSelectedLibraryItem(object sender = null, RoutedEventArgs e = null) {
            LibraryItem selected = GetSelectedLibraryItem();
            await ViewModel.ChangeSource(selected);
            selected.IncrementPlayCount();
        }

        private LibraryItem GetSelectedLibraryItem() {
            return (LibraryItem)libraryDataGrid.SelectedItem;
        }

        // This is where I set up keyboard accelerators and do some ridiculous hacks
        // to get keyboard control+focus working the way I want it.
        // Space should ALWAYS toggle playback, unless the search box has focus.
        // Escape should clear+exit the search box.
        // Enter should start playing a file when in the file view

        #region KeyboardStuff

        private void SetUpKeyboardAccelerators() {
            KeyboardAccelerator CreateAccelerator(VirtualKeyModifiers modifier, VirtualKey key,
                TypedEventHandler<KeyboardAccelerator, KeyboardAcceleratorInvokedEventArgs> eventHandler) {
                var ret = new KeyboardAccelerator() { Modifiers = modifier, Key = key };
                ret.Invoked += eventHandler;

                return ret;
            }

            //pull

            var pullAccelerator = CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.P,
                async (sender, args) => {
                    args.Handled = true;
                    await ViewModel.PullEventsCommand.ExecuteAsync(null);
                });
            KeyboardAccelerators.Add(pullAccelerator);

            //push
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift, VirtualKey.P,
    async (sender, args) => {
        args.Handled = true;
        await ViewModel.PushEventsCommand.ExecuteAsync(null);
    }));

            //search accelerator
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.F,
                (sender, args) => {
                    args.Handled = true;
                    FilterBox.Focus(FocusState.Keyboard);
                    FilterBox.SelectAll();
                }));

            //open local folder
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.E,
                async (sender, args) => {
                    args.Handled = true;
                    await Launcher.LaunchFolderAsync(Windows.Storage.ApplicationData.Current.LocalFolder);
                }));

            //open music folder
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.M,
                async (sender, args) => {
                    args.Handled = true;
                    await ViewModel.OpenLibraryFolder();
                }));

            //open library DB
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.D,
                async (sender, args) => {
                    args.Handled = true;
                    var dbFile = await FileHelper.GetLibraryDbFileAsync();
                    await Launcher.LaunchFileAsync(dbFile);
                }));

            //show selected item(s) in File Explorer
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.L,
                async (sender, args) => {
                    args.Handled = true;

                    var selected = (LibraryItem)libraryDataGrid.SelectedItem;
                    await ViewModel.ShowItemInExplorer(selected);
                }));

            //show item info
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.I,
                async (sender, args) => {
                    args.Handled = true;

                    var selected = libraryDataGrid.SelectedItem as LibraryItem;
                    if (selected != null) {
                        var dialog = new LibraryItemInfo(selected);
                        await dialog.ShowAsync();
                    }
                }));
        }

        private void Page_Loaded(object sender, RoutedEventArgs e) {
            Window.Current.CoreWindow.KeyDown += CoreWindow_KeyDown;
            FilterBox.PreviewKeyDown += FilterBox_PreviewKeyDown;
            libraryDataGrid.PreviewKeyDown += LibraryDataGrid_PreviewKeyDown;
        }

        private async void LibraryDataGrid_PreviewKeyDown(object sender, KeyRoutedEventArgs args) {
            if (args.Key == VirtualKey.Enter && !_dataGridIsEditing) {
                OpenSelectedLibraryItem();
                args.Handled = true;
            }

            if (args.Key == VirtualKey.Delete && !_dataGridIsEditing) {
                var selected = GetSelectedLibraryItem();

                if (selected is null)
                    return;

                await DeleteItemWithConfirmDialog(selected);

                args.Handled = true;
            }
        }

        private async Task DeleteItemWithConfirmDialog(LibraryItem item) {
            var confirmDialog = new ContentDialog {
                Title = "Delete file?",
                Content = $"Are you sure you want to delete '{item.Name}' from the library? Blob content will be unaffected.",
                PrimaryButtonText = "Delete",
                DefaultButton = ContentDialogButton.Primary,
                CloseButtonText = "Cancel"
            };

            var result = await confirmDialog.ShowAsync();

            if (result == ContentDialogResult.Primary) {
                ViewModel.Delete(item);
            }
        }

        private async void FilterBox_PreviewKeyDown(object sender, KeyRoutedEventArgs args) {
            switch (args.Key) {
                case VirtualKey.Escape:

                    if (libraryDataGrid.SelectedItems.Count > 0) {
                        libraryDataGrid.SelectedItems.Clear();
                    }
                    else {
                        if (FilterBox.Text == "") {
                            // hack: this just happens to move to the scrubbing control
                            // TODO: find a way of changing focus to the scrubbing control that does
                            // not rely on it being the next tab stop?
                            FocusManager.TryMoveFocus(FocusNavigationDirection.Previous);
                        }
                        else {
                            FilterBox.Text = "";
                        }
                    }

                    await FilterVMUsingFilterBoxText();

                    break;

                case VirtualKey.Enter:
                    if (libraryDataGrid.SelectedItems.Count > 0) {
                        OpenSelectedLibraryItem();
                    }

                    args.Handled = true;
                    break;

                case VirtualKey.Up:
                    libraryDataGrid.SelectedIndex--;
                    args.Handled = true;
                    break;

                case VirtualKey.Down:
                    libraryDataGrid.SelectedIndex++;
                    args.Handled = true;
                    break;

                default: break;
            }
        }

        private async Task FilterVMUsingFilterBoxText() {
            await ViewModel.FilterItems(FilterBox.Text);
        }

        private async void CoreWindow_KeyDown(Windows.UI.Core.CoreWindow sender, Windows.UI.Core.KeyEventArgs args) {
            if (args.VirtualKey == VirtualKey.Space) {
                var focusedCtrl = FocusManager.GetFocusedElement();
                if (!(focusedCtrl is TextBox)) {
                    ToggleMediaPlaybackState();
                }
            }
            //Not sure why but I can't get this to work in an accelerator, so it goes here
            else if (args.VirtualKey == VirtualKey.F5) {
                await ViewModel.PullEventsCommand.ExecuteAsync(null);
            }
        }

        private void Page_Unloaded(object sender, RoutedEventArgs e) {
            Window.Current.CoreWindow.KeyDown -= CoreWindow_KeyDown;
        }

        #endregion KeyboardStuff

        private void libraryDataGrid_BeginningEdit(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridBeginningEditEventArgs e) {
            _dataGridIsEditing = true;
        }

        private void libraryDataGrid_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            _dataGridIsEditing = false;
            UpdateCurrentlyPlayingText();
        }

        private void libraryDataGrid_RowEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridRowEditEndedEventArgs e) {
            _dataGridIsEditing = false;
            UpdateCurrentlyPlayingText();
        }

        // called once in constructor
        private void SetUpThumbnailAnimation() {
            CurrentlyPlayingThumbnail.RenderTransformOrigin = new Point(0.5, 0.5);
            CurrentlyPlayingThumbnail.RenderTransform = new RotateTransform();

            var animation = new DoubleAnimation();

            animation.Duration = new Duration(TimeSpan.FromSeconds(60d / 33)); // rekkid speed
            animation.From = 0;
            animation.To = 360;

            Storyboard.SetTarget(animation, CurrentlyPlayingThumbnail);
            Storyboard.SetTargetProperty(animation, "(UIElement.RenderTransform).(RotateTransform.Angle)");

            _thumbnailStoryboard.Children.Add(animation);
        }

        private void CurrentlyPlayingThumbnail_Tapped(object sender, TappedRoutedEventArgs e) {
            if (!_thumbNailIsRotating) {
                _thumbnailStoryboard.RepeatBehavior = RepeatBehavior.Forever;

                _thumbnailStoryboard.Begin();
            }
            else {
                _thumbnailStoryboard.RepeatBehavior = new RepeatBehavior(1);
            }

            _thumbNailIsRotating = !_thumbNailIsRotating;
        }

        private void libraryDataGrid_Sorting(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridColumnEventArgs e) {
            //TODO: implement
            //Use the Tag property to pass the bound column name for the sorting implementation
            //if (e.Column.Tag.ToString() == "") {
            //    //Implement sort on the column "Range" using LINQ
            //    if (e.Column.SortDirection == null || e.Column.SortDirection == DataGridSortDirection.Descending) {
            //        libraryDataGrid.ItemsSource = new ObservableCollection<Mountain>(from item in _items
            //                                                            orderby item.Range ascending
            //                                                            select item);
            //        e.Column.SortDirection = DataGridSortDirection.Ascending;
            //    }
            //    else {
            //        dg.ItemsSource = new ObservableCollection<Mountain>(from item in _items
            //                                                            orderby item.Range descending
            //                                                            select item);
            //        e.Column.SortDirection = DataGridSortDirection.Descending;
            //    }
            //}
        }

        private async void ShowItemInfo(object sender, RoutedEventArgs e) {
            var item = (sender as FrameworkElement).DataContext as LibraryItem;

            if (item != null) {
                var dialog = new LibraryItemInfo(item);
                await dialog.ShowAsync();
            }
        }

        private async void ShowRecentEvents(object sender, RoutedEventArgs e) {
            var recentEventsDialog = new RecentEventsContentDialog(ViewModel.GetRecentEvents());
            await recentEventsDialog.ShowAsync();
        }

        private async void DeleteMenuItem_Click(object sender, RoutedEventArgs e) {
            var item = (sender as FrameworkElement).DataContext as LibraryItem;

            if (item != null) {
                await DeleteItemWithConfirmDialog(item);
            }
        }

        private void CopyURLMenuItem_Click(object sender, RoutedEventArgs e) {
            var item = (sender as FrameworkElement).DataContext as LibraryItem;

            ViewModel.CopyUriToClipboard(item);
        }

        private void LibraryItemFlyout_Opening(object sender, object e) {
            var flyout = (MenuFlyout)sender;

            // Delete any tags we added previously
            const string dynamicMenuItemTag = "DynamicMenuItem";
            var existingDynamicItems = flyout.Items.Where(i => (i.Tag as string) == dynamicMenuItemTag);
            foreach (var dynamicItem in existingDynamicItems) {
                flyout.Items.Remove(dynamicItem);
            }

            var item = GetSelectedLibraryItem();
            if (item != null && item.Bookmarks.Any()) {
                var bookmarks = new MenuFlyoutSubItem() {
                    Icon = new SymbolIcon(Symbol.Bookmarks),
                    Tag = dynamicMenuItemTag,
                    Text = $"Bookmarks ({item.Bookmarks.Count})",
                };

                foreach (Bookmark bookmark in item.Bookmarks.OrderBy(b => b.Position)) {
                    // TODO: show emoji icon using a FontIcon
                    var bookmarkItem = new MenuFlyoutItem() { Text = $"{bookmark.Emoji ?? "♥"} {bookmark.Position}" };
                    bookmarkItem.Click += async (s, e) => { await ViewModel.PlayBookmark(item, bookmark); };
                    bookmarks.Items.Add(bookmarkItem);
                }

                flyout.Items.Add(bookmarks);
            }
        }
    }
}