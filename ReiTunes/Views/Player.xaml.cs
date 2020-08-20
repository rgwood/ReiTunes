﻿using ReiTunes.Configuration;
using ReiTunes.Core;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Media.Playback;
using Windows.System;
using Windows.UI.Text;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Documents;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Navigation;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=402352&clcid=0x409

namespace ReiTunes {

    /// <summary>
    /// The main UI of ReiTunes, a simple music player
    /// </summary>
    public sealed partial class Player : Page {
        public PlayerViewModel ViewModel { get; }

        private bool _dataGridIsEditing;

        public Player() {
            this.InitializeComponent();

            ApplicationView.GetForCurrentView().SetPreferredMinSize(new Size(200, 155));
            ViewModel = ServiceLocator.Current.GetService<PlayerViewModel>();
            SetUpKeyboardAccelerators();
            ViewModel.PropertyChanged += ViewModel_PropertyChanged;
        }

        private void ViewModel_PropertyChanged(object sender, System.ComponentModel.PropertyChangedEventArgs e) {
            if (e.PropertyName == nameof(ViewModel.CurrentlyPlayingItem)) {
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

        private void OpenSelectedLibraryItem(object sender = null, RoutedEventArgs e = null) {
            var selected = (LibraryItem)libraryDataGrid.SelectedItem;
            ViewModel.ChangeSource(selected);
            selected.IncrementPlayCount();
        }

        // This is where I set up keyboard accelerators and do some ridiculous hacks
        // to get keyboard control+focus working the way I want it.
        // Space should ALWAYS toggle playback, unless the search box has focus.
        // Escape should clear+exit the search box.
        // Enter should start playing a file when in the file view

        #region KeyboardStuff

        private void AddTooltip(DependencyObject target, string toolTip) {
        }

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
                    await ViewModel.Pull();
                });
            KeyboardAccelerators.Add(pullAccelerator);

            //push
            KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift, VirtualKey.P,
    async (sender, args) => {
        args.Handled = true;
        await ViewModel.Push();
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
        }

        private void Page_Loaded(object sender, RoutedEventArgs e) {
            Window.Current.CoreWindow.KeyDown += CoreWindow_KeyDown;
            FilterBox.KeyDown += HandleSpaceBar;
            FilterBox.PreviewKeyDown += FilterBox_PreviewKeyDown;
            libraryDataGrid.PreviewKeyDown += LibraryDataGrid_PreviewKeyDown;
        }

        private void LibraryDataGrid_PreviewKeyDown(object sender, KeyRoutedEventArgs args) {
            if (args.Key == VirtualKey.Enter && !_dataGridIsEditing) {
                OpenSelectedLibraryItem();
                args.Handled = true;
            }
        }

        private void FilterBox_PreviewKeyDown(object sender, KeyRoutedEventArgs args) {
            switch (args.Key) {
                case VirtualKey.Escape:
                    if (FilterBox.Text == "") {
                        // hack: this just happens to move to the scrubbing control
                        // TODO: find a way of changing focus to the scrubbing control that does
                        // not rely on it being the next tab stop?
                        FocusManager.TryMoveFocus(FocusNavigationDirection.Previous);
                    }
                    else {
                        FilterBox.Text = "";
                    }
                    break;

                case VirtualKey.Enter:
                    OpenSelectedLibraryItem();
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

        private void HandleSpaceBar(object sender, KeyRoutedEventArgs args) {
            if (args.Key == VirtualKey.Space) {
                args.Handled = true;
            }
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
                await ViewModel.Pull();
            }
        }

        private void Page_Unloaded(object sender, RoutedEventArgs e) {
            Window.Current.CoreWindow.KeyDown -= CoreWindow_KeyDown;
        }

        #endregion KeyboardStuff

        private async void FilterBox_TextChanged(object sender, TextChangedEventArgs e) {
            var searchstring = FilterBox.Text;
            await ViewModel.FilterItems(searchstring);
        }

        private void libraryDataGrid_BeginningEdit(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridBeginningEditEventArgs e) {
            _dataGridIsEditing = true;
        }

        private void libraryDataGrid_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            _dataGridIsEditing = false;
        }

        private void libraryDataGrid_RowEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridRowEditEndedEventArgs e) {
            _dataGridIsEditing = false;
        }
    }
}