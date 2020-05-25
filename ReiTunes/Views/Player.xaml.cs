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
        private AppWindow fileWindow;
        private Frame appWindowFrame = new Frame();
        private bool _layoutUpdatedHasFired = false;
        public PlayerViewModel ViewModel { get; }

        public Player()
        {
            ViewModel = Singleton<PlayerViewModel>.Instance;
            this.InitializeComponent();
            LayoutUpdated += OpenFileWindowHandler;
        }

        /* HACK ALERT! We open the file viewer on the first LayoutUpdated event, because I
         * couldn't get AppWindow.TryShowAsync() to work correctly earlier. I tried opening
         * it during OnNavigatedTo and Loaded, but that results in intermittent crashes with
         * a "0x80070490 Element not found." error. I suspect this is a bug in the preview
         * AppWindow code, but I'm not 100% sure.
         * 
         * This was the only mention of that bug I could find: https://stackoverflow.com/q/61929691
         * But the asker just gave up and called TryShowAsync later.
         * 
         * Based on, this I decided to try LayoutUpdated: https://stackoverflow.com/a/34364213
         * "LayoutUpdated is the last object lifetime event to occur in the XAML load sequence before
         * a control is ready for interaction. However, LayoutUpdated can also occur at run time 
         * during the object lifetime, for a variety of reasons"
         */
        private async void OpenFileWindowHandler(object sender, object e)
        {
            if(!_layoutUpdatedHasFired)
            {
                _layoutUpdatedHasFired = true;
                await OpenFileWindow();
            }
        }

        protected async override void OnNavigatedTo(NavigationEventArgs e)
        {
            base.OnNavigatedTo(e);
            await ViewModel.Initialize();
        }

        private async Task OpenFileWindow()
        {
            if(fileWindow == null)
            {
                fileWindow = await AppWindow.TryCreateAsync();
                fileWindow.Title = "Files";
                fileWindow.RequestSize(new Size(200, 200));
                fileWindow.Closed += delegate { fileWindow = null; appWindowFrame.Content = null; };

                ElementCompositionPreview.SetAppWindowContent(fileWindow, appWindowFrame);

                Point offset = new Point(x: 0, y: 170);
                fileWindow.RequestMoveRelativeToCurrentViewContent(offset);

                await fileWindow.TryShowAsync();

                appWindowFrame.Navigate(typeof(FileList));
            }
        }

        private async void Open_Files(object sender, RoutedEventArgs e)
        {
            await OpenFileWindow();
        }
    }
}
