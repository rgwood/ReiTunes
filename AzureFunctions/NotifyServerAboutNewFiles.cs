// Default URL for triggering event grid function in the local environment.
// http://localhost:7071/runtime/webhooks/EventGrid?functionName={functionname}

using System;
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
    public void Run([EventGridTrigger] CloudEvent cloudEvent)
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

            // TODO: make HTTP call with API key to notify server about new file

        }
        else
        {
            _logger.LogDebug($"Doing nothing, change occurred in container '{container}'");
        }
    }
}
