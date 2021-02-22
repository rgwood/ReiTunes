using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using ReiTunes.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace ReiTunes.Server.Controllers {

    [ApiController]
    [Route("reitunes")]
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
        [Route("allevents")]
        public IEnumerable<string> Get() {
            return _eventRepo.GetAllSerializedEvents();
        }

        [HttpPut]
        [Route("createitem")]
        public void CreateItem(string filePath) {
            _eventRepo.Save(_eventFactory.GetCreatedEvent(Guid.NewGuid(), filePath, filePath));
        }

        [HttpPut]
        [Route("saveevents")]
        // TODO: wire up the ASP.NET Core custom deserialization instead of handling it myself?
        public async Task Save() {
            using StreamReader reader = new StreamReader(Request.Body);
            string serializedEvents = await reader.ReadToEndAsync();

            List<IEvent> deserialized = await EventSerialization.DeserializeListAsync(serializedEvents);

            _eventRepo.Save(deserialized);
        }
    }
}