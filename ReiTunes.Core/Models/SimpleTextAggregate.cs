using System;

namespace ReiTunes.Core {

    public class SimpleTextAggregate : Aggregate {
        private string _text = "";

        public string Text {
            get => _text;
            set {
                ApplyButDoNotCommit(new SimpleTextAggregateUpdatedEvent(Guid.NewGuid(), AggregateId, DateTime.UtcNow, value));
                NotifyPropertyChanged();
            }
        }

        public SimpleTextAggregate() {
        }

        public SimpleTextAggregate(string text) {
            ApplyButDoNotCommit(new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), Guid.NewGuid(), DateTime.UtcNow, text));
        }

        public SimpleTextAggregate(Guid aggregateId, string text) {
            ApplyButDoNotCommit(new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), aggregateId, DateTime.UtcNow, text));
        }

        public void Initialize(Guid aggregateId, string text) {
            ApplyButDoNotCommit(new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), aggregateId: aggregateId, DateTime.UtcNow, text));
        }

        protected override void RegisterAppliers() {
            this.RegisterApplier<SimpleTextAggregateCreatedEvent>(this.Apply);
            this.RegisterApplier<SimpleTextAggregateUpdatedEvent>(this.Apply);
        }

        private void Apply(SimpleTextAggregateCreatedEvent @event) {
            AggregateId = @event.AggregateId;
            _text = @event.Text;
            NotifyPropertyChanged(nameof(Text));
        }

        private void Apply(SimpleTextAggregateUpdatedEvent @event) {
            _text = @event.Text;
            NotifyPropertyChanged(nameof(Text));
        }

        public override string ToString() {
            return Text;
        }
    }
}