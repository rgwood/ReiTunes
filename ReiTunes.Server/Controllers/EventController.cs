using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using ReiTunes.Core;

namespace ReiTunes.Server.Controllers {

    [ApiController]
    [Route("events")]
    public class EventController : ControllerBase {
        private readonly ILogger<EventController> _logger;
        private readonly ISerializedEventRepository _eventRepo;
        private readonly LibraryItemEventFactory _eventFactory;

        public EventController(ILogger<EventController> logger, ISerializedEventRepository eventRepo, LibraryItemEventFactory eventFactory) {
            _logger = logger;
            _eventRepo = eventRepo;
            _eventFactory = eventFactory;
        }

        [HttpGet]
        public IEnumerable<string> Get() {
            return _eventRepo.GetAllSerializedEvents();
        }

        [HttpPut]
        [Route("create")]
        public void CreateItem(string filePath) {
            _eventRepo.Save(_eventFactory.GetCreatedEvent(Guid.NewGuid(), filePath, filePath));
        }

        [HttpPut]
        [Route("save")]
        public async Task Save(string serializedEvent) {
            var deserialized = await EventSerialization.DeserializeAsync(serializedEvent);
            _eventRepo.Save(deserialized);
        }
    }
}