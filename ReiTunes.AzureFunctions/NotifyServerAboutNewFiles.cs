// Default URL for triggering event grid function in the local environment.
// http://localhost:7071/runtime/webhooks/EventGrid?functionName={functionname}
using System;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Azure.EventGrid.Models;
using Microsoft.Azure.WebJobs;
using Microsoft.Azure.WebJobs.Extensions.EventGrid;
using Microsoft.Extensions.Logging;
using ReiTunes.Core;

namespace ReiTunes.AzureFunctions
{

    public static class NotifyServerAboutNewFiles
    {

        [FunctionName("NotifyServerAboutNewFiles")]
        public static async Task Run([EventGridTrigger] EventGridEvent eventGridEvent, ILogger log)
        {
            log.LogInformation(eventGridEvent.Data.ToString());

            //example subject: "/blobServices/default/containers/test-container/blobs/new-file.txt",
            string[]? tokens = eventGridEvent.Subject.Split("/");
            string? container = tokens[4];
            if (container.Equals(Constants.MusicContainerName, StringComparison.OrdinalIgnoreCase))
            {
                string? filePath = string.Join('/', tokens.Skip(6));
                log.LogInformation($"Change detected in container {container} for file '{filePath}'");

                // I know this is bad and idgaf. This thing shouldn't be invoked so often that it needs a shared HttpClient
                HttpClient? httpClient = new HttpClient();
                ServerCaller? serverCaller = new ServerCaller(httpClient, Serilog.Core.Logger.None);

                await serverCaller.CreateNewLibraryItemAsync(filePath);
            }
            else
            {
                log.LogDebug($"Doing nothing, change occurred in container '{container}'");
            }
        }
    }
}
