using Microsoft.Toolkit.Uwp.Helpers;
using ReiTunes.Configuration;
using System;
using System.Threading.Tasks;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;

namespace ReiTunes.Services {

    public static class FirstRunService {
        private static bool shown = false;

        internal static async Task ShowIfAppropriateAsync() {
            await CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
                CoreDispatcherPriority.Normal, async () => {
                    if (SystemInformation.IsFirstRun && !shown) {
                        // pull events in for the first time
                        await ServiceLocator.Current.GetService<PlayerViewModel>().PullEventsCommand.ExecuteAsync(null);
                        shown = true;
                        //var dialog = new FirstRunDialog();
                        //await dialog.ShowAsync();
                    }
                });
        }
    }
}