using Serilog;

namespace ReiTunes.Core
{

    public class LoggerHelpers
    {

        public static ILogger DoNothingLogger()
        {
            return new LoggerConfiguration().CreateLogger();
        }
    }
}