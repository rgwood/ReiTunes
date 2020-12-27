using ReiTunes.Configuration;
using ReiTunes.Core;
using Windows.UI.Xaml.Controls;

// The Content Dialog item template is documented at https://go.microsoft.com/fwlink/?LinkId=234238

namespace ReiTunes.Views {

    public sealed partial class LibraryItemInfo : ContentDialog {
        private readonly LibraryItem _item;
        private PlayerViewModel _viewModel;

        public LibraryItemInfo(LibraryItem item) {
            this.InitializeComponent();
            _item = item;

            foreach (var bookmark in _item.Bookmarks) {
                BookmarksView.Items.Add(bookmark);
            }

            _viewModel = ServiceLocator.Current.GetService<PlayerViewModel>();
        }

        private void ContentDialog_SecondaryButtonClick(ContentDialog sender, ContentDialogButtonClickEventArgs args) {
            var selected = BookmarksView.SelectedItem as Bookmark;

            if (selected != null) {
                if (_viewModel.CurrentlyPlayingItem == _item) {
                    _viewModel.MediaPlayer.PlaybackSession.Position = selected.Position;
                }
            }
        }
    }
}