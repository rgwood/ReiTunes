using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Windows.Media.Core;
using Windows.System;
using Windows.Storage;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Controls.Primitives;
using Windows.UI.Xaml.Data;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;
using Windows.Media.Playback;
using Windows.UI.WindowManagement;
using Windows.UI.Xaml.Hosting;
using System.Threading.Tasks;
using System.Collections.ObjectModel;
using Windows.UI.ViewManagement;
using ReiTunes;
using ReiTunes.Core.Helpers;
using ReiTunes.Configuration;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=402352&clcid=0x409

namespace ReiTunes
{
    /// <summary>
    /// The main UI of ReiTunes, a simple music player
    /// </summary>
    public sealed partial class Player : Page
    {
        public PlayerViewModel ViewModel { get; }

        public Player()
        {
            this.InitializeComponent();
            ViewModel = ServiceLocator.Current.GetService<PlayerViewModel>();
            SetUpKeyboardAccelerators();
        }



        private void ToggleMediaPlaybackState()
        {
            var mediaPlayer = musicPlayer.MediaPlayer;
            var currState = mediaPlayer.PlaybackSession.PlaybackState;
            if (currState == MediaPlaybackState.Playing)
            {
                mediaPlayer.Pause();
            }
            else if (currState == MediaPlaybackState.Paused || currState == MediaPlaybackState.None)
            {
                mediaPlayer.Play();
            }
        }

        protected async override void OnNavigatedTo(NavigationEventArgs e)
        {
            base.OnNavigatedTo(e);
            await ViewModel.Initialize();
        }

        private void OpenSelectedFileTreeItem(object sender = null, RoutedEventArgs e = null)
        {
            var selected = (FileTreeItem)FileTreeView.SelectedItem;
            ViewModel.ChangeSource(selected?.FullPath);
        }

        private void SearchBox_TextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
        {
            if (args.Reason == AutoSuggestionBoxTextChangeReason.UserInput)
            {
                var typedText = sender.Text;

                var files = ViewModel.FlattenedFileList().Where(i => i.Type == FileTreeItemType.File);

                var fuzzyMatchResults =
                    from file in files
                    let fuzzyResult = FuzzyMatcher.FuzzyMatch(file.FullPath, typedText)
                    where fuzzyResult.isMatch
                    orderby fuzzyResult.score descending
                    select file;

                //Set the ItemsSource to be your filtered dataset
                sender.ItemsSource = fuzzyMatchResults.ToList();
            }
        }

        private void SearchBox_QuerySubmitted(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
        {
            var selection = (FileTreeItem)args.ChosenSuggestion;
            ViewModel.ChangeSource(selection?.FullPath);
        }

        // This is where I set up keyboard accelerators and do some ridiculous hacks 
        // to get keyboard control+focus working the way I want it.
        // Space should ALWAYS toggle playback, unless the search box has focus.
        // Escape should clear+exit the search box.
        // Enter should start playing a file when in the file view
        #region KeyboardStuff
        private void SetUpKeyboardAccelerators()
        {
            KeyboardAccelerator CreateAccelerator(VirtualKeyModifiers modifier, VirtualKey key,
                TypedEventHandler<KeyboardAccelerator, KeyboardAcceleratorInvokedEventArgs> eventHandler)
            {
                var ret = new KeyboardAccelerator()
                {
                    Modifiers = modifier,
                    Key = key
                };
                ret.Invoked += eventHandler;
                return ret;
            }

            //search accelerator
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.F,
                (sender, args) =>
                {
                    args.Handled = true;
                    SearchBox.Focus(FocusState.Keyboard);
                }));

            //refresh accelerator
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.R,
                async (sender, args) =>
                {
                    args.Handled = true;
                    await ViewModel.DownloadAndLoadLibraryFile();
                }));

            //open cache
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.E,
                async (sender, args) =>
                {
                    args.Handled = true;
                    await Launcher.LaunchFolderAsync(Windows.Storage.ApplicationData.Current.LocalCacheFolder);
                }));
        }

        private void Page_Loaded(object sender, RoutedEventArgs e)
        {
            Window.Current.CoreWindow.KeyDown += CoreWindow_KeyDown;
            SearchBox.KeyDown += SearchBox_KeyDown;
            SearchBox.PreviewKeyDown += SearchBox_PreviewKeyDown;
            FileTreeView.PreviewKeyDown += FileTreeView_PreviewKeyDown;
        }

        private void FileTreeView_PreviewKeyDown(object sender, KeyRoutedEventArgs args)
        {
            if (args.Key == VirtualKey.Enter)
                OpenSelectedFileTreeItem();
        }

        private void SearchBox_PreviewKeyDown(object sender, KeyRoutedEventArgs args)
        {
            if (args.Key == VirtualKey.Escape)
            {
                SearchBox.Text = "";
                // hack: this just happens to move to the scrubbing control
                // TODO: find a way of changing focus to the scrubbing control that does
                // not rely on it being the next tab stop
                FocusManager.TryMoveFocus(FocusNavigationDirection.Next);
            }
        }

        private void SearchBox_KeyDown(object sender, KeyRoutedEventArgs args)
        {
            if (args.Key == VirtualKey.Space)
            {
                args.Handled = true;
            }
        }

        private void CoreWindow_KeyDown(Windows.UI.Core.CoreWindow sender, Windows.UI.Core.KeyEventArgs args)
        {
            if (args.VirtualKey == VirtualKey.Space)
            {
                var focusedCtrl = FocusManager.GetFocusedElement();
                if (!(focusedCtrl is TextBox))
                {
                    ToggleMediaPlaybackState();
                }
            }
        }

        private void Page_Unloaded(object sender, RoutedEventArgs e)
        {
            Window.Current.CoreWindow.KeyDown -= CoreWindow_KeyDown;
        }
        #endregion

    }
}
