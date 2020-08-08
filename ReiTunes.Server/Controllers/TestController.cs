using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace ReiTunes.Server.Controllers {

    /// <summary>
    /// A dead-simple controller to exercise test infrastructure
    /// </summary>
    [ApiController]
    [Route("test")]
    public class TestController : ControllerBase {
        private readonly ILogger<TestController> _logger;

        public static string GoodString => "foo";
        public static string BadString => "bar";

        public TestController(ILogger<TestController> logger) {
            _logger = logger;
        }

        [HttpGet]
        public string Get() => "foo";

        [HttpGet]
        [Route("exclaim")]
        public string Exclaim(string input) {
            return input + "!";
        }

        [HttpPut]
        [Route("validate")]
        public void Validate(string input) {
            if (input != GoodString)
                throw new Exception($"bad input '{input}'");
        }
    }
}