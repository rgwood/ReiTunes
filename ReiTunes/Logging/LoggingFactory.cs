using Serilog;
using Serilog.Formatting.Compact;
using System.IO;

namespace ReiTunes.Logging {

    public static class LoggingFactory {

        static public ILogger BuildLogger() {
            var cache = Windows.Storage.ApplicationData.Current.LocalFolder;
            var logFile = Path.Combine(cache.Path, "ReiTunes.txt");

            return new LoggerConfiguration()
                      .WriteTo.File(new RenderedCompactJsonFormatter(), logFile, rollingInterval: RollingInterval.Day)
                      .CreateLogger();
        }
    }
}