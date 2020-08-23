using Serilog;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public class LoggerHelpers {

        public static ILogger DoNothingLogger() {
            return new LoggerConfiguration().CreateLogger();
        }
    }
}