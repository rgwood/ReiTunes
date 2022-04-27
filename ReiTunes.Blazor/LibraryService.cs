public class LibraryService : IHostedService
{
    private ILogger<LibraryService> _logger;

    public LibraryService(ILogger<LibraryService> logger)
    {
        _logger = logger;
    }
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("LibraryService starting");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("LibraryService stopping");
        return Task.CompletedTask;
    }
}