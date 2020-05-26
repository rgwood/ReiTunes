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
    /// The main UI of ReiTunes, a simple music player control.
    /// </summary>
    public sealed partial class Player : Page
    {
        private bool _layoutUpdatedHasFired = false;
        public PlayerViewModel ViewModel { get; }

        public Player()
        {
            // Only ever have one player in the application, and we want it to be controllable by other components
            ViewModel = Singleton<PlayerViewModel>.Instance;
            this.InitializeComponent();
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
    }
}
