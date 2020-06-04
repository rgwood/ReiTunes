using ReiTunes.Configuration;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Windows.System;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Controls.Primitives;
using Windows.UI.Xaml.Data;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=234238

namespace ReiTunes.Views
{
    /// <summary>
    /// An empty page that can be used on its own or navigated to within a Frame.
    /// </summary>
    public sealed partial class FileTreeWindow : Page
    {
        // I think I'm going to MVVM hell for reusing PlayerViewModel like this, but whatever,
        // there's only ever going to be one per app instance
        public PlayerViewModel ViewModel { get; }

        public FileTreeWindow()
        {
            this.InitializeComponent();
            ViewModel = ServiceLocator.Current.GetService<PlayerViewModel>();
            SetUpKeyboardAccelerators();
        }

        private void OpenSelectedFileTreeItem(object sender = null, RoutedEventArgs e = null)
        {
            var selected = (FileTreeItem)FileTreeView.SelectedItem;
            ViewModel.ChangeSource(selected?.FullPath);
        }

        //TODO: this is largely copied from Player, figure out how to reduce duplication
        private void SetUpKeyboardAccelerators()
        {
            KeyboardAccelerator CreateAccelerator(VirtualKeyModifiers modifier, VirtualKey key,
                TypedEventHandler<KeyboardAccelerator, KeyboardAcceleratorInvokedEventArgs> eventHandler)
            {
                var ret = new KeyboardAccelerator() { Modifiers = modifier, Key = key };
                ret.Invoked += eventHandler;
                return ret;
            }

            //TODO: figure out how to open search in the player window from here
            //search accelerator
            //KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.F,
            //    (sender, args) =>
            //    {
            //        args.Handled = true;
            //        SearchBox.Focus(FocusState.Keyboard);
            //    }));

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

            //TODO: this should close the window
            //toggle file pane
            //KeyboardAccelerators.Add(CreateAccelerator(VirtualKeyModifiers.Control, VirtualKey.C,
            //    async (sender, args) =>
            //    {
            //        args.Handled = true;
            //        await OpenFileTreeView();
            //    }));
        }
    }
}