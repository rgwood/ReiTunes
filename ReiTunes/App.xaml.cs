using Microsoft.Toolkit.Uwp.UI.Helpers;
using ReiTunes.Configuration;
using ReiTunes.Services;
using Serilog;
using System;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.ApplicationModel.Core;
using Windows.ApplicationModel.DataTransfer;
using Windows.ApplicationModel.DataTransfer.ShareTarget;
using Windows.System;
using Windows.UI;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Media;

namespace ReiTunes {

    /// <summary>
    /// Provides application-specific behavior to supplement the default Application class.
    /// </summary>
    sealed partial class App : Application {
        //private readonly Size MainWindowSize = new Size(800, 650);

        private ThemeListener _themeListener;

        /// <summary>
        /// Initializes the singleton application object.  This is the first line of authored code
        /// executed, and as such is the logical equivalent of main() or WinMain().
        /// </summary>
        public App() {
            InitializeComponent();

            // Close the application when the primary window closes
            //ApplicationView.GetForCurrentView().Consolidated += App_Consolidated;
            //ApplicationView.PreferredLaunchViewSize = MainWindowSize;
            //ApplicationView.PreferredLaunchWindowingMode = ApplicationViewWindowingMode.PreferredLaunchViewSize;

            ApplicationView.PreferredLaunchWindowingMode = ApplicationViewWindowingMode.Maximized;

            EnteredBackground += App_EnteredBackground;
            Resuming += App_Resuming;
            UnhandledException += App_UnhandledException;
        }

        private void App_Consolidated(ApplicationView sender, ApplicationViewConsolidatedEventArgs args) {
            throw new NotImplementedException();
        }

        private void App_UnhandledException(object sender, Windows.UI.Xaml.UnhandledExceptionEventArgs e) {
            var logger = ServiceLocator.Current.GetService<ILogger>();
            logger.Fatal("Unhandled exception '{Message}': {Exception}", e.Message, e.Exception);

            // help the user take a look at the logs
            Launcher.LaunchFolderAsync(Windows.Storage.ApplicationData.Current.LocalFolder).AsTask().Wait();
        }

        /// <summary>
        /// Invoked when the application is launched normally by the end user.  Other entry points
        /// will be used such as when the application is launched to open a specific file.
        /// </summary>
        /// <param name="args">Details about the launch request and process.</param>
        protected override async void OnLaunched(LaunchActivatedEventArgs args) {
            if (!args.PrelaunchActivated) {
                await Startup.ActivateAsync(args);
            }

            var coreTitleBar = CoreApplication.GetCurrentView().TitleBar;
            // Hide default title bar. This setting persists and needs to be reset manually
            coreTitleBar.ExtendViewIntoTitleBar = true;

            var titleBar = ApplicationView.GetForCurrentView().TitleBar;
            _themeListener = new ThemeListener();
            _themeListener.ThemeChanged += SetCloseButtonBackgroundColorFromTheme;

            titleBar.ButtonBackgroundColor = Colors.Transparent;
            titleBar.ButtonInactiveBackgroundColor = Colors.Transparent;

            SetCloseButtonBackgroundColorFromTheme(_themeListener);
        }

        private void SetCloseButtonBackgroundColorFromTheme(ThemeListener sender) {
            var titleBar = ApplicationView.GetForCurrentView().TitleBar;

            switch (sender.CurrentTheme) {
                case ApplicationTheme.Light:
                    titleBar.ButtonForegroundColor = ((SolidColorBrush)Application.Current.Resources["base03"]).Color;
                    titleBar.ButtonHoverBackgroundColor = ((SolidColorBrush)Application.Current.Resources["base2"]).Color;
                    break;

                case ApplicationTheme.Dark:
                    titleBar.ButtonForegroundColor = ((SolidColorBrush)Application.Current.Resources["base3"]).Color;
                    titleBar.ButtonHoverBackgroundColor = ((SolidColorBrush)Application.Current.Resources["base03"]).Color;
                    break;

                default:
                    break;
            }
        }

        protected override async void OnActivated(IActivatedEventArgs args) {
            await Startup.ActivateAsync(args);
        }

        protected override async void OnShareTargetActivated(ShareTargetActivatedEventArgs args) {
            ShareOperation shareOperation = args.ShareOperation;
            if (shareOperation.Data.Contains(StandardDataFormats.WebLink)) {
                Uri uri = await shareOperation.Data.GetWebLinkAsync();
                if (uri != null) {
                    var logger = ServiceLocator.Current.GetService<ILogger>();
                    logger.Information("Received URI: {uri}", uri);
                    args.ShareOperation.ReportCompleted();
                    return;
                }
            }

            args.ShareOperation.ReportError("Failed to share, couldn't get a URI");
        }

        private async void App_EnteredBackground(object sender, EnteredBackgroundEventArgs e) {
            var deferral = e.GetDeferral();
            await ServiceLocator.Current.GetService<SuspendAndResumeService>().SaveStateAsync();
            deferral.Complete();
        }

        private void App_Resuming(object sender, object e) {
            ServiceLocator.Current.GetService<SuspendAndResumeService>().ResumeApp();
        }
    }
}