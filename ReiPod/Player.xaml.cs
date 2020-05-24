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

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=402352&clcid=0x409

namespace ReiPod
{
    /// <summary>
    /// An empty page that can be used on its own or navigated to within a Frame.
    /// </summary>
    public sealed partial class Player : Page
    {
        private AppWindow appWindow;
        private Frame appWindowFrame = new Frame();

        public Player()
        {
            this.InitializeComponent();
        }

        protected async override void OnNavigatedTo(NavigationEventArgs e)
        {
            base.OnNavigatedTo(e);
            var file = await StorageFile.GetFileFromPathAsync(@"C:\Users\reill\Music\AvalanchesJamie.mp3");
            var source = MediaSource.CreateFromStorageFile(file);
            //MediaPlaybackItem playbackItem = new MediaPlaybackItem(source);
            
            this.musicPlayer.Source = source;
            
            
            this.musicPlayer.MediaPlayer.Play();
            Debug.WriteLine("hello");

            appWindow = await AppWindow.TryCreateAsync();
            appWindow.Title = "Files";
            appWindow.RequestSize(new Size(200, 200));
            appWindow.Closed += delegate { appWindow = null; appWindowFrame.Content = null; };
            ElementCompositionPreview.SetAppWindowContent(appWindow, appWindowFrame);
            await appWindow.TryShowAsync();
        }


    }
}
