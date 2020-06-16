using System.Collections.Generic;
using System;

namespace ReiTunes.Core {

    public abstract class Aggregate {
        private readonly List<IEvent> _uncommittedChanges;
        protected Dictionary<Type, Action<IEvent>> _eventAppliers;

        protected Aggregate() {
            _uncommittedChanges = new List<IEvent>();
            _eventAppliers = new Dictionary<Type, Action<IEvent>>();
            RegisterAppliers();
        }

        protected abstract void RegisterAppliers();

        protected void RegisterApplier<TEvent>(Action<TEvent> applier) where TEvent : IEvent {
            _eventAppliers.Add(typeof(TEvent), (x) => applier((TEvent)x));
        }

        public Guid Id { get; set; }

        public string AggregateName { get { return GetType().Name; } }

        protected void ApplyUncommitted(IEvent evt) {
            Apply(evt);
            _uncommittedChanges.Add(evt);
        }

        public void Apply(IEvent evt) {
            var evtType = evt.GetType();
            if (!_eventAppliers.ContainsKey(evtType)) {
                throw new NotImplementedException($"Apply() not implemented for {evtType}");
            }
            _eventAppliers[evtType](evt);
        }

        public void ApplyEvents(IEnumerable<IEvent> history) {
            foreach (var evt in history) {
                Apply(evt);
            }
        }

        public IEnumerable<IEvent> GetUncommitedChanges() {
            return _uncommittedChanges.AsReadOnly();
        }

        public void Commit() {
            _uncommittedChanges.Clear();
        }
    }
}