using Microsoft.Toolkit.Uwp.Helpers;
using System;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Core;
using Windows.UI.Core;
using Windows.UI.Xaml.Controls;

namespace ReiTunes.Services
{
    // For instructions on testing this service see https://github.com/Microsoft/WindowsTemplateStudio/blob/master/docs/UWP/features/whats-new-prompt.md
    public static class WhatsNewDisplayService
    {
        private static bool shown = false;

        internal static async Task ShowIfAppropriateAsync()
        {
            await CoreApplication.MainView.CoreWindow.Dispatcher.RunAsync(
                CoreDispatcherPriority.Normal, async () =>
                {
                    if (SystemInformation.IsAppUpdated && !shown)
                    {
                        shown = true;
                        var ver = Package.Current.Id.Version;

                        ContentDialog dialog = new ContentDialog() {
                            Title = "ReiTunes Was Updated",
                            Content = $"Now on version {ver.Major}.{ver.Minor}.{ver.Build}.{ver.Revision}",
                            CloseButtonText= "Cool"
                        };
                        await dialog.ShowAsync();
                    }
                });
        }
    }
}