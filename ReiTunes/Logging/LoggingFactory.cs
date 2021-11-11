using Serilog;
using System.IO;

namespace ReiTunes.Logging;

public static class LoggingFactory
{

    static public ILogger BuildLogger()
    {
        Windows.Storage.StorageFolder cache = Windows.Storage.ApplicationData.Current.LocalFolder;
        string logFile = Path.Combine(cache.Path, "ReiTunes_Logs_.txt");

        return new LoggerConfiguration()
                  .WriteTo.File(logFile, rollingInterval: RollingInterval.Day)
                  .CreateLogger();
    }
}
