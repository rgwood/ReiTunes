using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Windows.Media.Core;
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
using ReiPod;
using ReiTunes.Core.Helpers;

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
            // Only ever have one player in the application, and we want it to be controllable by other components
            ViewModel = Singleton<PlayerViewModel>.Instance;
            SetUpKeyboardAccelerators();
        }

        private void SetUpKeyboardAccelerators()
        {
            var searchAccelerator = new KeyboardAccelerator()
            {
                Modifiers = Windows.System.VirtualKeyModifiers.Control,
                Key = Windows.System.VirtualKey.F
            };
            searchAccelerator.Invoked += (sender, args) =>
            {
                SearchBox.Focus(FocusState.Keyboard);
                args.Handled = true;
            };
            KeyboardAccelerators.Add(searchAccelerator);
        }

        protected async override void OnNavigatedTo(NavigationEventArgs e)
        {
            base.OnNavigatedTo(e);
            await ViewModel.Initialize();
        }

        private void TreeViewItem_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            var selected = (FileTreeItem)FileTreeView.SelectedItem;
            ViewModel.ChangeSource(selected.Name);
        }

        private void SearchBox_TextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
        {
            if (args.Reason == AutoSuggestionBoxTextChangeReason.UserInput)
            {
                var typedText = sender.Text;
                
                //todo: handle folders
                var files = ViewModel.FileTreeItems.Where(i => i.Type == FileTreeItemType.File);

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
            var selection = (FileTreeItem) args.ChosenSuggestion;
            ViewModel.ChangeSource(selection.FullPath);
        }
    }
}
