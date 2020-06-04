using ReiTunes.Configuration;
using ReiTunes.Services;
using Serilog;
using System;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.Foundation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;

namespace ReiTunes
{
    /// <summary>
    /// Provides application-specific behavior to supplement the default Application class.
    /// </summary>
    sealed partial class App : Application
    {
        private readonly Size MainWindowSize = new Size(400, 450);

        /// <summary>
        /// Initializes the singleton application object.  This is the first line of authored code
        /// executed, and as such is the logical equivalent of main() or WinMain().
        /// </summary>
        public App()
        {
            InitializeComponent();

            // Close the application when the primary window closes
            //ApplicationView.GetForCurrentView().Consolidated += App_Consolidated;
            ApplicationView.PreferredLaunchViewSize = MainWindowSize;
            ApplicationView.PreferredLaunchWindowingMode = ApplicationViewWindowingMode.PreferredLaunchViewSize;

            EnteredBackground += App_EnteredBackground;
            Resuming += App_Resuming;
            UnhandledException += App_UnhandledException;
        }

        private void App_Consolidated(ApplicationView sender, ApplicationViewConsolidatedEventArgs args)
        {
            throw new NotImplementedException();
        }

        private void App_UnhandledException(object sender, Windows.UI.Xaml.UnhandledExceptionEventArgs e)
        {
            var logger = ServiceLocator.Current.GetService<ILogger>();
            logger.Fatal("Unhandled exception '{Message}': {Exception}", e.Message, e.Exception);
        }

        /// <summary>
        /// Invoked when the application is launched normally by the end user.  Other entry points
        /// will be used such as when the application is launched to open a specific file.
        /// </summary>
        /// <param name="args">Details about the launch request and process.</param>
        protected override async void OnLaunched(LaunchActivatedEventArgs args)
        {
            if (!args.PrelaunchActivated)
            {
                await Startup.ActivateAsync(args);
            }
        }

        protected override async void OnActivated(IActivatedEventArgs args)
        {
            await Startup.ActivateAsync(args);
        }

        private async void App_EnteredBackground(object sender, EnteredBackgroundEventArgs e)
        {
            var deferral = e.GetDeferral();
            await ServiceLocator.Current.GetService<SuspendAndResumeService>().SaveStateAsync();
            deferral.Complete();
        }

        private void App_Resuming(object sender, object e)
        {
            ServiceLocator.Current.GetService<SuspendAndResumeService>().ResumeApp();
        }
    }
}