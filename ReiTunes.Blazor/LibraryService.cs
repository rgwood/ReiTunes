using ReiTunes.Core;

namespace ReiTunes.Blazor;

public class LibraryService : IHostedService
{
    private readonly Serilog.ILogger _logger;
    private readonly Library _library;
    private readonly ServerCaller _caller;

    public LibraryService(Serilog.ILogger logger, Library library, ServerCaller caller)
    {
        _logger = logger;
        _library = library;
        _caller = caller;
    }
    public Task StartAsync(CancellationToken cancellationToken)
    {
        // _logger.Information("LibraryService starting");

        // TODO: How much of this should be wired up in DI instead?
        // Maybe depends on whether we expect things to be used elsewhere.
        // var expectedLibraryFilePath = Environment.ExpandEnvironmentVariables("%HOME%/.local/share/reitunes/library.db");
        // var db = SQLiteHelpers.CreateFileDb(expectedLibraryFilePath);

        // var library = new Library(db, _logger, _caller);

        // foreach (var item in _library.Items.Take(5))
        // {
        //     _logger.Information(item.ToString());
        // }

        // var events = await _caller.PullAllEventsAsync();
        // _logger.Information($"Pulled {events.Count()} events from server");

        // _logger.Information("LibraryService started");

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.Information("LibraryService stopping");
        return Task.CompletedTask;
    }
}
