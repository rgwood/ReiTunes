using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Data.SQLite;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    public class Library {

        public event PropertyChangedEventHandler PropertyChanged;

        public event EventHandler LibraryItemsRebuilt;

        public string MachineName { get; private set; }

        public List<LibraryItem> Items { get; set; } = new List<LibraryItem>();
        private readonly ISerializedEventRepository _repo;
        private readonly ServerCaller _caller;
        private readonly LibraryItemEventFactory _eventFactory;

        public Library(string machineName, SQLiteConnection connection, ServerCaller caller)
            : this(machineName, connection, caller, new Clock()) { }

        public Library(string machineName, SQLiteConnection connection, ServerCaller caller, IClock clock) {
            MachineName = machineName;
            _caller = caller;
            _repo = new SQLiteEventRepository(connection);
            _eventFactory = new LibraryItemEventFactory(MachineName, clock);
            RebuildItems();
        }

        public void ReceiveEvents(IEnumerable<IEvent> events) {
            foreach (var @event in events) {
                _repo.Save(@event);
            }
            RebuildItems();
        }

        public void ReceiveEvent(IEvent @event) {
            ReceiveEvents(new List<IEvent> { @event });
        }

        public IEnumerable<IEvent> GetAllEvents() {
            return _repo.GetAllEvents();
        }

        public async Task PullFromServer() {
            var events = await _caller.PullAllEventsAsync();
            ReceiveEvents(events);
        }

        public async Task PushToServer() {
            var allEvents = GetAllEvents();

            await _caller.PushEventsAsync(allEvents);
        }

        private void RebuildItems() {
            Items.Clear();

            var events = GetAllEvents();

            var groupedEvents = events.GroupBy(e => e.AggregateId).Select(g => g.OrderBy(e => e.CreatedTimeUtc).ThenBy(e => e.LocalId));

            foreach (var aggregateEvents in groupedEvents) {
                var aggregate = new LibraryItem(_eventFactory);

                var first = aggregateEvents.First();

                if (!(first is LibraryItemCreatedEvent)) {
                    throw new Exception($"Bad event data: first event for item {first.AggregateId} is of type {first.GetType()} not {nameof(LibraryItemCreatedEvent)}");
                }

                aggregate.EventCreated += SaveEventToRepo;
                foreach (var @event in aggregateEvents) {
                    aggregate.Apply(@event);
                }
                Items.Add(aggregate);
            }

            LibraryItemsRebuilt?.Invoke(this, EventArgs.Empty);
        }

        private void SaveEventToRepo(object sender, IEvent e) {
            _repo.Save(e);
            var agg = (Aggregate)sender;
            agg.Commit();
        }
    }
}