using System;
using System.Collections.Generic;
using System.Linq;

namespace ReiTunes.Core;

public class InMemoryEventRepository : IEventRepository
{
    private readonly List<IEvent> _events = new List<IEvent>();

    public bool ContainsEvent(Guid eventId)
    {
        return _events.Any(e => e.Id == eventId);
    }

    public int CountOfAllEvents() => _events.Count();

    public IEnumerable<IEvent> GetAllEvents()
    {
        return _events;
    }

    public IEnumerable<IEvent> GetAllEventsFromMachine(string machineName)
    {
        return _events.Where(e => e.MachineName.ToUpper() == machineName.ToUpper());
    }

    public IEnumerable<IEvent> GetEvents(Guid aggregateId)
    {
        return _events.Where(e => e.AggregateId == aggregateId);
    }

    public void Save(IEvent @event)
    {
        if (ContainsEvent(@event.Id))
            return;

        if (string.IsNullOrEmpty(@event.MachineName))
        {
            throw new Exception($"Machine name not specified on event {@event.Id}");
        }

        _events.Add(@event);
    }

    public void Save(IEnumerable<IEvent> events)
    {
        foreach (IEvent @event in events)
        {
            Save(@event);
        }
    }
}
