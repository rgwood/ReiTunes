// Default URL for triggering event grid function in the local environment.
// http://localhost:7071/runtime/webhooks/EventGrid?functionName={functionname}
using System;
using Microsoft.Azure.WebJobs;
using Microsoft.Azure.WebJobs.Host;
using Microsoft.Azure.EventGrid.Models;
using Microsoft.Azure.WebJobs.Extensions.EventGrid;
using Microsoft.Extensions.Logging;
using ReiTunes.Core;
using System.Threading.Tasks;
using System.Text;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using System.IO;

namespace ReiTunes.AzureFunctions
{
    public static class RegenerateLibraryFile
    {
        [FunctionName("RegenerateLibraryFile")]
        public static async Task Run([EventGridTrigger]EventGridEvent eventGridEvent, ILogger log)
        {
            log.LogInformation(eventGridEvent.Data.ToString());

            //Doesn't really matter what the event is, if anything in music changes we regenerate the library
            //example subject: "/blobServices/default/containers/test-container/blobs/new-file.txt",
            var container = eventGridEvent.Subject.Split("/")[4];
            if(container.Equals(Constants.MusicContainerName, StringComparison.OrdinalIgnoreCase))
            {
                log.LogInformation($"Change detected in container {container}");
                var storageConnectionString = GetStorageConnectionString();
                var library = await GenerateLibrary(storageConnectionString, log);
                await WriteLibrary(storageConnectionString, library, log);
            }
            else
            {
                log.LogDebug($"Doing nothing, change occurred in container '{container}'");
            }
        }

        static string GetStorageConnectionString()
        {
            var storageConnectionString = Environment.GetEnvironmentVariable("ReiTunesBlobStorageConnectionString");
            if (storageConnectionString == null)
            {
                throw new Exception("Could not get blob storage connection string");
            }
            return storageConnectionString;
        }
            

        static async Task<string> GenerateLibrary(string connectionString, ILogger log)
        {
            var ret = new StringBuilder();
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Constants.MusicContainerName);

            await foreach (BlobItem blobItem in containerClient.GetBlobsAsync())
            {
                ret.AppendLine(blobItem.Name);
            }

            log.LogInformation($"Successfully generated library based on {Constants.MusicContainerName} contents");
            return ret.ToString();
        }

        static async Task WriteLibrary(string connectionString, string libraryContents, ILogger log)
        {
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Constants.LibraryContainerName);
            BlobClient blobClient = containerClient.GetBlobClient(Constants.LibraryFileName);

            using (var libraryContentsStream = GenerateStreamFromString(libraryContents))
            {
                await blobClient.UploadAsync(libraryContentsStream, true);
            }

            log.LogInformation($"Successfully wrote library to {Constants.LibraryFileName}/{Constants.LibraryFileName}");
        }


        public static Stream GenerateStreamFromString(string s)
        {
            var stream = new MemoryStream();
            var writer = new StreamWriter(stream);
            writer.Write(s);
            writer.Flush();
            stream.Position = 0;
            return stream;
        }
    }
}
