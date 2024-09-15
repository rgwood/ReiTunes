// Default URL for triggering event grid function in the local environment.
// http://localhost:7071/runtime/webhooks/EventGrid?functionName={functionname}

using System;
using System.Net.Http.Json;
using Azure.Messaging;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace ReiTunes;

public class NotifyServerAboutNewFiles
{
    private readonly ILogger<NotifyServerAboutNewFiles> _logger;

    public NotifyServerAboutNewFiles(ILogger<NotifyServerAboutNewFiles> logger)
    {
        _logger = logger;
    }

    const string MusicContainerName = "music";

    [Function(nameof(NotifyServerAboutNewFiles))]
    public async Task Run([EventGridTrigger] CloudEvent cloudEvent)
    {
        _logger.LogInformation("Event type: {type}, Event subject: {subject}", cloudEvent.Type, cloudEvent.Subject);
        _logger.LogInformation(cloudEvent.Data.ToString());

        //example subject: "/blobServices/default/containers/test-container/blobs/new-file.txt",
        string[]? tokens = cloudEvent.Subject.Split("/");
        string? container = tokens[4];
        if (container.Equals(MusicContainerName, StringComparison.OrdinalIgnoreCase))
        {
            string? filePath = string.Join('/', tokens.Skip(6));
            _logger.LogInformation($"Change detected in container {container} for file '{filePath}'");

            using var client = new HttpClient();
            client.DefaultRequestHeaders.Add("x-api-key", Environment.GetEnvironmentVariable("REITUNES_API_KEY"));

            var content = JsonContent.Create(new { file_path = filePath });
            var response = await client.PostAsync($"{Environment.GetEnvironmentVariable("REITUNES_HOSTNAME")}/api/add", content);
            _logger.LogInformation($"Response: {response.StatusCode}");
            response.EnsureSuccessStatusCode();
        }
        else
        {
            _logger.LogDebug($"Doing nothing, change occurred in container '{container}'");
        }
    }
}
