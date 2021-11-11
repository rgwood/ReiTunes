using Azure.Storage.Blobs;

namespace ReiTunes.DevTools;

internal class Program
{

    private static void Main(string[] args)
    {
        // setx AZURE_STORAGE_CONNECTION_STRING "<yourconnectionstring>"
        string connectionString = Environment.GetEnvironmentVariable("AZURE_STORAGE_CONNECTION_STRING");
        BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
        BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Core.Constants.MusicContainerName);

        // do blob stuff here
    }
}
