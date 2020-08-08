using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace ReiTunes.Server.Controllers {

    [ApiController]
    [Route("events")]
    public class EventController : ControllerBase {
        private readonly ILogger<EventController> _logger;

        public EventController(ILogger<EventController> logger) {
            _logger = logger;
        }

        [HttpGet]
        public IEnumerable<string> Get() {
            return new List<string>() { "foo", "bar" };
        }

        [HttpPut]
        [Route("exclaim")]
        public string Exclaim(string input) {
            return input + "!";
        }
    }
}