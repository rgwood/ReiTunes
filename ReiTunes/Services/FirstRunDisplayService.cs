using Microsoft.Toolkit.Uwp.Helpers;
using System;
using System.Threading.Tasks;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;

namespace ReiTunes.Services
{
    public static class FirstRunDisplayService
    {
        private static bool shown = false;

        internal static async Task ShowIfAppropriateAsync()
        {
            await CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
                // re-enable when we actually start using this feature
#pragma warning disable CS1998 // Async method lacks 'await' operators and will run synchronously
                CoreDispatcherPriority.Normal, async () =>
#pragma warning restore CS1998 // Async method lacks 'await' operators and will run synchronously
                {
                    if (SystemInformation.IsFirstRun && !shown)
                    {
                        shown = true;
                        //var dialog = new FirstRunDialog();
                        //await dialog.ShowAsync();
                    }
                });
        }
    }
}