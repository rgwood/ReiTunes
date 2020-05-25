using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.UI.Core;

namespace ReiPod.Helpers
{
    public static class DispatcherHelper
    {
        public static void ThrowIfNotOnUiThread()
        {
            var dispatcher = CoreWindow.GetForCurrentThread().Dispatcher;
            if(!dispatcher.HasThreadAccess)
            {
                throw new ThreadStateException("Not on UI thread");
            }
        }
    }
}
