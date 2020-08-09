using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Data.SQLite;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;

namespace ReiTunes.Core {

    public class Library : INotifyPropertyChanged {

        public event PropertyChangedEventHandler PropertyChanged;

        public event EventHandler LibraryItemsRebuilt;

        public string MachineName { get; private set; }

        public List<LibraryItem> Models { get; set; } = new List<LibraryItem>();
        private readonly ISerializedEventRepository _repo;
        private readonly ServerCaller _caller;
        private readonly LibraryItemEventFactory _eventFactory;

        public Library(string machineName, SQLiteConnection connection, ServerCaller caller) {
            MachineName = machineName;
            _caller = caller;
            _repo = new SQLiteEventRepository(connection);
            _eventFactory = new LibraryItemEventFactory(MachineName);
        }

        public void Commit() {
            //foreach (var model in Models) {
            //    foreach (var @event in model.GetUncommittedEvents()) {
            //        @event.MachineName = MachineName;
            //        _repo.Save(@event);
            //    }

            //    model.Commit();
            //}
        }

        public void ReceiveEvents(IEnumerable<IEvent> events) {
            foreach (var @event in events) {
                _repo.Save(@event);
            }
            RebuildModels();
        }

        public void ReceiveEvent(IEvent @event) {
            ReceiveEvents(new List<IEvent> { @event });
        }

        public void RebuildModels() {
            Models.Clear();

            var events = GetAllEvents();

            var groupedEvents = events.GroupBy(e => e.AggregateId).Select(g => g.OrderBy(e => e.CreatedTimeUtc).ThenBy(e => e.LocalId));

            foreach (var aggregateEvents in groupedEvents) {
                var aggregate = new LibraryItem(_eventFactory);

                var first = aggregateEvents.First();

                if (!(first is LibraryItemCreatedEvent)) {
                    throw new Exception($"Bad event data: first event for item {first.AggregateId} is of type {first.GetType()} not {nameof(LibraryItemCreatedEvent)}");
                }

                aggregate.EventCreated += Agg_EventCreated;
                foreach (var @event in aggregateEvents) {
                    aggregate.Apply(@event);
                }
                Models.Add(aggregate);
            }

            LibraryItemsRebuilt?.Invoke(this, EventArgs.Empty);
        }

        private void Agg_EventCreated(object sender, IEvent e) {
            _repo.Save(e);
            var agg = (Aggregate)sender;
            agg.Commit();
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return _repo.GetAllEvents();
        }

        protected void NotifyPropertyChanged([CallerMemberName] string propertyName = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}