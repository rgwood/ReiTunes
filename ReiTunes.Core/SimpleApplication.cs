using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;

namespace ReiTunes.Core;

public class SimpleApplication : INotifyPropertyChanged
{

    public event PropertyChangedEventHandler PropertyChanged;

    public string MachineName { get; set; }

    public ObservableCollection<SimpleTextAggregate> Models { get; set; } = new ObservableCollection<SimpleTextAggregate>();
    private InMemoryJsonEventRepository Repo { get; set; } = new InMemoryJsonEventRepository();

    public SimpleApplication(string machineName)
    {
        MachineName = machineName;
    }

    public void Commit()
    {
        foreach (SimpleTextAggregate model in Models)
        {
            foreach (IEvent @event in model.GetUncommittedEvents())
            {
                Repo.Save(@event);
            }

            model.Commit();
        }
    }

    public void ReceiveEvents(IEnumerable<IEvent> events)
    {
        foreach (IEvent @event in events)
        {
            Repo.Save(@event);
        }
        RebuildModels();
    }

    public void RebuildModels()
    {
        Models.Clear();

        IEnumerable<IEvent> events = GetAllEvents();

        IEnumerable<IOrderedEnumerable<IEvent>> groupedEvents = events.GroupBy(e => e.AggregateId).Select(g => g.OrderBy(e => e.CreatedTimeUtc));

        foreach (IOrderedEnumerable<IEvent> aggregateEvents in groupedEvents)
        {
            SimpleTextAggregate aggregate = new SimpleTextAggregate();
            foreach (IEvent @event in aggregateEvents)
            {
                aggregate.Apply(@event);
            }
            Models.Add(aggregate);
        }
    }

    public IEnumerable<IEvent> GetAllEvents()
    {
        return Repo.GetAllEvents();
    }

    protected void NotifyPropertyChanged([CallerMemberName] string propertyName = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
