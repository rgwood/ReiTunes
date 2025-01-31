namespace ReiTunes.Core;

public interface IEventRepository
{

    public IEnumerable<IEvent> GetEvents(Guid aggregateId);

    public IEnumerable<IEvent> GetAllEvents();

    public IEnumerable<IEvent> GetAllEventsFromMachine(string machineName);

    public int CountOfAllEvents();

    public void Save(IEvent @event);

    public void Save(IEnumerable<IEvent> events);

    public bool ContainsEvent(Guid eventId);
}

public interface ISerializedEventRepository : IEventRepository
{

    public IEnumerable<string> GetAllSerializedEvents();
}
