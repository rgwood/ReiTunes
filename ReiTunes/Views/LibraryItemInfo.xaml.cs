using ReiTunes.Configuration;
using ReiTunes.Core;
using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Windows.Storage;
using Windows.Storage.FileProperties;
using Windows.UI.ViewManagement.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Input;

// The Content Dialog item template is documented at https://go.microsoft.com/fwlink/?LinkId=234238

namespace ReiTunes.Views {

    public sealed partial class LibraryItemInfo : ContentDialog, INotifyPropertyChanged {
        private readonly LibraryItem _item;
        private PlayerViewModel _viewModel;

        private string _existsOnDisk = "Unknown";
        private MusicProperties _musicProps;

        public LibraryItemInfo(LibraryItem item) {
            this.InitializeComponent();
            _item = item;

            foreach (var bookmark in _item.Bookmarks.OrderBy(b => b.Position)) {
                if (bookmark.Emoji.HasValue) {
                    BookmarksView.Items.Add(bookmark);
                }
                else {
                    BookmarksView.Items.Add(bookmark with { Emoji = '❤' });
                }
            }

            _viewModel = ServiceLocator.Current.GetService<PlayerViewModel>();

            Loaded += LibraryItemInfo_Loaded;

            BookmarksView.Loaded += BookmarksView_Loaded;
        }

        // https://stackoverflow.com/a/44332607/854694
        private void BookmarksView_Loaded(object sender, Windows.UI.Xaml.RoutedEventArgs e) {
            (sender as ListView).AddHandler(UIElement.KeyDownEvent, new KeyEventHandler(BookmarksView_KeyDown), true);
        }

        private async void BookmarksView_KeyDown(object sender, KeyRoutedEventArgs args) {
            if (args.Key == Windows.System.VirtualKey.Enter) {
                await PlaySelectedBookmark();
            }
        }

        private async void LibraryItemInfo_Loaded(object sender, Windows.UI.Xaml.RoutedEventArgs e) {
            StorageFile file = await _viewModel.GetStorageFile(_item);

            _existsOnDisk = file is null ? "No" : "Yes";
            OnPropertyChanged(nameof(_existsOnDisk));

            if (file != null) {
                _musicProps = await file.Properties.GetMusicPropertiesAsync();
                OnPropertyChanged(nameof(_musicProps));
            }
        }

        private void ContentDialog_SecondaryButtonClick(ContentDialog sender, ContentDialogButtonClickEventArgs args) {
        }

        private string BitsToKilobits(uint bits) => (bits / 1000).ToString();

        private async Task PlaySelectedBookmark() {
            var selected = BookmarksView.SelectedItem as Bookmark;

            if (selected != null) {
                if (_viewModel.CurrentlyPlayingItem != _item) {
                    await _viewModel.ChangeSource(_item);
                }

                _viewModel.MediaPlayer.PlaybackSession.Position = selected.Position;
                _viewModel.MediaPlayer.Play();
            }
        }

        private async void BookmarksView_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e) {
            await PlaySelectedBookmark();
        }

        public event PropertyChangedEventHandler PropertyChanged;

        private void Set<T>(ref T storage, T value, [CallerMemberName] string propertyName = null) {
            if (Equals(storage, value)) {
                return;
            }

            storage = value;
            OnPropertyChanged(propertyName);
        }

        private void OnPropertyChanged(string propertyName) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));

        private void EmojiHolder_BeforeTextChanging(TextBox sender, TextBoxBeforeTextChangingEventArgs args) {
            // Trying to intercept text change events so there can only be 1 emoji in the box at a time.
            // Doesn't quite work, new characters don't update properly in the UI 🤔

            //    string oldText = sender.Text;
            //    string newText = args.NewText;

            //    if (emojiCount(newText) > 1) {
            //        args.Cancel = true;
            //        string newTextMinusOldText = new Regex(Regex.Escape(oldText)).Replace(newText, "", 1);
            //        sender.Text = newTextMinusOldText;
            //    }

            //    int emojiCount(string input) => new System.Globalization.StringInfo(input).LengthInTextElements;
        }

        private void EmojiHolder_GotFocus(object sender, RoutedEventArgs e) {
            CoreInputView.GetForCurrentView().TryShow(CoreInputViewKind.Emoji);
        }

        private void EmojiHolder_TextChanged(object sender, TextChangedEventArgs args) {
            //string oldText =
            //string newText = args.NewText;

            //if (emojiCount(newText) > 1) {
            //    string newTextMinusOldText = new Regex(Regex.Escape(oldText)).Replace(newText, "", 1);
            //    sender.Text = newTextMinusOldText;
            //}

            //int emojiCount(string input) => new System.Globalization.StringInfo(input).LengthInTextElements;
        }

        private void EmojiHolder_Tapped(object sender, TappedRoutedEventArgs e) {
            CoreInputView.GetForCurrentView().TryShow(CoreInputViewKind.Emoji);
        }

        private void SetEmojiButton_Click(object sender, RoutedEventArgs e) {
        }
    }
}