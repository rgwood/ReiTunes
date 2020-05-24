using System;
using System.Threading.Tasks;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

namespace ReiTunes.DevTools
{
    class Program
    {
        static async Task Main(string[] args)
        {
            // setx AZURE_STORAGE_CONNECTION_STRING "<yourconnectionstring>"
            var connectionString = Environment.GetEnvironmentVariable("AZURE_STORAGE_CONNECTION_STRING");
            await ListBlobs(connectionString);
        }

        static async Task ListBlobs(string connectionString)
        {
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient("reitunes");

            await foreach (BlobItem blobItem in containerClient.GetBlobsAsync())
            {
                Console.WriteLine(blobItem.Name);
            }
        }

    }
}
