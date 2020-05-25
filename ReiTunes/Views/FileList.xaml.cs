using ReiPod;
using ReiTunes.Core.Helpers;
using ReiTunes.Helpers;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Controls.Primitives;
using Windows.UI.Xaml.Data;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=234238

namespace ReiTunes
{
    /// <summary>
    /// List of music files
    /// </summary>
    public sealed partial class FileList : Page
    {
        public FileListViewModel ViewModel { get; } = new FileListViewModel();
        public FileList()
        {
            this.InitializeComponent();
        }

        protected async override void OnNavigatedTo(NavigationEventArgs e)
        {
            base.OnNavigatedTo(e);
            await ViewModel.Initialize();
        }

        private void TreeViewItem_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            var selected = (FileTreeItem) FileTreeView.SelectedItem;
            Singleton<PlayerViewModel>.Instance.ChangeSource(selected.Name);
        }
    }
}
