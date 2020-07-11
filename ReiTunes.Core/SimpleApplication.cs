using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;

namespace ReiTunes.Core {

    public class SimpleApplication : INotifyPropertyChanged {

        public event PropertyChangedEventHandler PropertyChanged;

        //public SimpleTextAggregate Model { get; set; } = new SimpleTextAggregate();

        public string MachineName { get; set; }

        public ObservableCollection<SimpleTextAggregate> Models { get; set; } = new ObservableCollection<SimpleTextAggregate>();
        public InMemoryJsonEventRepository Repo { get; set; } = new InMemoryJsonEventRepository();

        public SimpleApplication(string machineName) {
            MachineName = machineName;
            //Model = new SimpleTextAggregate(aggregateId, startingValue);
            //Commit();
        }

        public void Commit() {
            foreach (var model in Models) {
                foreach (var @event in model.GetUncommittedEvents()) {
                    //TODO: append machine name here
                    @event.MachineName = MachineName;
                    Repo.Save(@event);
                }

                model.Commit();
            }
        }

        public void ReceiveEvents(IEnumerable<IEvent> events) {
            foreach (var @event in events) {
                Repo.Save(@event);
            }
            RebuildModels();
        }

        public void RebuildModels() {
            Models.Clear();

            var events = GetAllEvents();

            var groupedEvents = events.GroupBy(e => e.AggregateId).Select(g => g.OrderBy(e => e.CreatedTimeUtc));

            foreach (var aggregateEvents in groupedEvents) {
                var aggregate = new SimpleTextAggregate();
                foreach (var @event in aggregateEvents) {
                    aggregate.Apply(@event);
                }
                Models.Add(aggregate);
            }
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return Repo.GetAllEvents();
        }

        protected void NotifyPropertyChanged([CallerMemberName] string propertyName = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}