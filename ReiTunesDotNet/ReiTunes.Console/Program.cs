using ReiTunes.Core;
using Serilog;

var logger = new LoggerConfiguration()
    .WriteTo.Console()
    .CreateLogger();

var httpClient = new HttpClient();
var serverCaller = new ServerCaller(httpClient, logger);

var expectedLibraryFilePath = Environment.ExpandEnvironmentVariables("%HOME%/.local/share/reitunes/library.db");
System.IO.Directory.CreateDirectory(expectedLibraryFilePath);
var db = SQLiteHelpers.CreateFileDb(expectedLibraryFilePath);

var library = new Library(db, logger, serverCaller);

foreach (var item in library.Items.Reverse().Take(10))
{
    logger.Information(item.ToString());
}
