using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace ReiTunes.Core {

    public abstract class Aggregate : INotifyPropertyChanged {
        private readonly List<IEvent> _uncommittedEvents;
        protected Dictionary<Type, Action<IEvent>> _eventAppliers;

        public event PropertyChangedEventHandler PropertyChanged;

        public event EventHandler<IEvent> EventCreated;

        public DateTime CreatedTimeUtc { get; protected set; }

        protected Aggregate() {
            _uncommittedEvents = new List<IEvent>();
            _eventAppliers = new Dictionary<Type, Action<IEvent>>();
            RegisterAppliers();
        }

        protected abstract void RegisterAppliers();

        protected void RegisterApplier<TEvent>(Action<TEvent> applier) where TEvent : IEvent {
            _eventAppliers.Add(typeof(TEvent), (x) => applier((TEvent)x));
        }

        public Guid AggregateId { get; set; }

        public string AggregateName { get { return GetType().Name; } }

        protected void ApplyButDoNotCommit(IEvent evt) {
            Apply(evt);
            _uncommittedEvents.Add(evt);
            EventCreated?.Invoke(this, evt);
        }

        public void Apply(IEvent evt) {
            Type evtType = evt.GetType();
            if (!_eventAppliers.ContainsKey(evtType)) {
                throw new NotImplementedException($"Apply() not implemented for {evtType}");
            }
            _eventAppliers[evtType](evt);
        }

        public void Apply(IEnumerable<IEvent> history) {
            foreach (IEvent evt in history) {
                Apply(evt);
            }
        }

        public IEnumerable<IEvent> GetUncommittedEvents() {
            return _uncommittedEvents.AsReadOnly();
        }

        public void Commit() {
            _uncommittedEvents.Clear();
        }

        protected void NotifyPropertyChanged([CallerMemberName] string propertyName = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}