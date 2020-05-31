using Serilog;
using Serilog.Formatting.Compact;
using System;
using System.Collections.Generic;
using System.IO;

namespace ReiTunes.Logging
{
    public static class LoggingFactory
    {
        static public ILogger BuildLogger()
        {
            var cache = Windows.Storage.ApplicationData.Current.LocalCacheFolder;
            var logFile = Path.Combine(cache.Path, "ReiTunes.txt");

            return new LoggerConfiguration()
                      .WriteTo.File(new CompactJsonFormatter(), logFile, rollingInterval: RollingInterval.Day)
                      .CreateLogger();
        }
    }
}
