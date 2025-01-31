namespace ReiTunes.Core;

public interface IServerCaller
{
    Task CreateNewLibraryItemAsync(string filePath);
    Task<IEnumerable<IEvent>> PullAllEventsAsync();
    Task<List<string>> PullAllSerializedEventsAsync();
    Task PushEventAsync(IEvent @event);
    Task PushEventsAsync(IEnumerable<IEvent> events);
}

public class NoopServerCaller : IServerCaller
{
    public Task CreateNewLibraryItemAsync(string filePath) => Task.CompletedTask;

    public Task<IEnumerable<IEvent>> PullAllEventsAsync()
        => Task.FromResult((IEnumerable<IEvent>)new List<IEvent>());

    public Task<List<string>> PullAllSerializedEventsAsync() =>
        Task.FromResult(new List<string>());

    public Task PushEventAsync(IEvent @event) => Task.CompletedTask;

    public Task PushEventsAsync(IEnumerable<IEvent> events) => Task.CompletedTask;
}
