using System.Threading;
using Windows.UI.Core;

namespace ReiTunes.Helpers
{
    public static class DispatcherHelper
    {
        public static void ThrowIfNotOnUiThread()
        {
            var dispatcher = CoreWindow.GetForCurrentThread().Dispatcher;
            if (!dispatcher.HasThreadAccess)
            {
                throw new ThreadStateException("Not on UI thread");
            }
        }
    }
}