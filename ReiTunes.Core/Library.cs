using Microsoft.Data.Sqlite;
using Serilog;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;

namespace ReiTunes.Core
{

    public class Library
    {

        public event EventHandler LibraryItemsRebuilt;

        public string MachineName { get; private set; }

        public List<LibraryItem> Items { get; set; } = new List<LibraryItem>();
        private readonly ISerializedEventRepository _repo;
        private readonly IServerCaller _caller;
        private readonly ILogger _logger;
        private readonly LibraryItemEventFactory _eventFactory;

        public Library(SqliteConnection connection, ILogger logger, IServerCaller caller)
            : this(Environment.MachineName, connection, caller, logger, new Clock()) { }


        public Library(string machineName, SqliteConnection connection, IServerCaller caller, ILogger logger)
            : this(machineName, connection, caller, logger, new Clock()) { }

        public Library(string machineName, SqliteConnection connection, IServerCaller caller, ILogger logger, IClock clock)
        {
            MachineName = machineName;
            _caller = caller;
            _logger = logger;
            _repo = new SQLiteEventRepository(connection, logger);
            _eventFactory = new LibraryItemEventFactory(clock, MachineName);
            RebuildItems();
        }

        public void ReceiveEvents(IEnumerable<IEvent> events)
        {
            foreach (IEvent @event in events)
            {
                _repo.Save(@event);
            }
            RebuildItems();
        }

        public void ReceiveEvent(IEvent @event)
        {
            ReceiveEvents(new List<IEvent> { @event });
        }

        public async Task PullFromServer()
        {
            IEnumerable<IEvent> events = await _caller.PullAllEventsAsync();
            ReceiveEvents(events);
        }

        public async Task PushToServer()
        {
            IEnumerable<IEvent> eventsToPush = _repo.GetAllEventsFromMachine(MachineName);

            await _caller.PushEventsAsync(eventsToPush);

            int pushedCount = eventsToPush.Count();
            double totalEventCount = (double)_repo.CountOfAllEvents();

            _logger.Information("Pushed {PushedCount} of {TotalEventCount} events ({PercentageOfAllEvents}%)",
                pushedCount, totalEventCount, 100 * pushedCount / totalEventCount);
        }

        //todo: make async
        public IEnumerable<string> GetRecentEvents()
        {
            return _repo.GetAllSerializedEvents().Reverse().Take(10);
        }

        public void Delete(LibraryItem item)
        {
            _repo.Save(_eventFactory.GetDeletedEvent(item.AggregateId));
            RebuildItems();
        }

        internal void RebuildItems()
        {
            Stopwatch sw = Stopwatch.StartNew();
            IEnumerable<IEvent> events = _repo.GetAllEvents();
            RebuildItems(events);

            _logger.Information("Rebuilding all items took {ElapsedMs} ms", sw.ElapsedMilliseconds);
        }

        internal void RebuildItems(IEnumerable<IEvent> events)
        {
            Items.Clear();

            IEnumerable<IOrderedEnumerable<IEvent>> groupedEvents = events.GroupBy(e => e.AggregateId).Select(g => g.OrderBy(e => e.CreatedTimeUtc).ThenBy(e => e.LocalId));

            foreach (IOrderedEnumerable<IEvent> aggregateEvents in groupedEvents)
            {
                LibraryItem aggregate = new LibraryItem(_eventFactory);

                IEvent first = aggregateEvents.First();

                if (!(first is LibraryItemCreatedEvent))
                {
                    throw new Exception($"Bad event data: first event for item {first.AggregateId} is of type {first.GetType()} not {nameof(LibraryItemCreatedEvent)}");
                }

                aggregate.EventCreated += SaveEventToRepo;

                aggregate.Apply(aggregateEvents);

                Items.Add(aggregate);
            }

            List<LibraryItem> itemsToDelete = Items.Where(i => i.Tombstoned).ToList();

            foreach (LibraryItem item in itemsToDelete)
            {
                Items.Remove(item);
            }

            LibraryItemsRebuilt?.Invoke(this, EventArgs.Empty);
        }

        private void SaveEventToRepo(object sender, IEvent e)
        {
            _repo.Save(e);
            Aggregate agg = (Aggregate)sender;
            agg.Commit();
        }
    }
}