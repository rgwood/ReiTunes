using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using ReiTunes.Core;

namespace ReiTunes.Core {

    public class SimpleTextAggregate : Aggregate {
        private string _text = "";

        public string Text {
            get => _text;
            set {
                ApplyUncommitted(new SimpleTextAggregateUpdatedEvent(Guid.NewGuid(), DateTime.UtcNow, value));
            }
        }

        public SimpleTextAggregate() {
        }

        public SimpleTextAggregate(string text) {
            ApplyUncommitted(new SimpleTextAggregateCreatedEvent(Guid.NewGuid(), DateTime.UtcNow, text));
        }

        protected override void RegisterAppliers() {
            this.RegisterApplier<SimpleTextAggregateCreatedEvent>(this.Apply);
            this.RegisterApplier<SimpleTextAggregateUpdatedEvent>(this.Apply);
        }

        private void Apply(SimpleTextAggregateCreatedEvent @event) {
            Id = @event.Id;
            _text = @event.Text;
        }

        private void Apply(SimpleTextAggregateUpdatedEvent @event) {
            _text = @event.Text;
        }
    }
}