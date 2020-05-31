using System;
using System.Threading.Tasks;
using Microsoft.Toolkit.Uwp.Helpers;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;

namespace ReiTunes.Services
{
    // For instructions on testing this service see https://github.com/Microsoft/WindowsTemplateStudio/blob/master/docs/UWP/features/whats-new-prompt.md
    public static class WhatsNewDisplayService
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
                    if (SystemInformation.IsAppUpdated && !shown)
                    {
                        shown = true;
                        //var dialog = new WhatsNewDialog();
                        //await dialog.ShowAsync();
                    }
                });
        }
    }
}
