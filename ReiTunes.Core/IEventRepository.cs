using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.Core {

    internal interface IEventRepository {

        public IEnumerable<IEvent> GetEvents(Guid id);

        public void Save(IEvent @event);
    }
}