using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.WebUtilities;
using Newtonsoft.Json;
using ReiTunes.Server.Controllers;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Xunit;

namespace ReiTunes.Server.Tests {

    public class IntegrationTests : IClassFixture<WebApplicationFactory<ReiTunes.Server.Startup>> {
        private readonly WebApplicationFactory<Startup> _factory;

        public IntegrationTests(WebApplicationFactory<Startup> factory) {
            _factory = factory;
        }

        [Fact]
        public async Task TestControllerGetWorks() {
            var client = _factory.CreateClient();

            var response = await client.GetAsync("/test");

            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            Assert.Equal("foo", contents);
        }

        [Fact]
        public async Task TestControllerGetWithParamWorks() {
            var client = _factory.CreateClient();

            var response = await client.GetAsync("/test/exclaim?input=foo");

            response.EnsureSuccessStatusCode();

            var contents = await response.Content.ReadAsStringAsync();

            Assert.Equal("foo!", contents);
        }

        [Fact]
        public async Task TestControllerPutOK() {
            var client = _factory.CreateClient();

            var uri = QueryHelpers.AddQueryString("/test/validate", "input", TestController.GoodString);

            var response = await client.PutAsync(uri, null);
            response.EnsureSuccessStatusCode();
        }

        [Fact]
        public async Task TestControllerPutFails() {
            var client = _factory.CreateClient();

            var uri = QueryHelpers.AddQueryString("/test/validate", "input", TestController.BadString);

            var response = await client.PutAsync(uri, null);
            Assert.False(response.IsSuccessStatusCode);
        }
    }
}