using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using ReiTunes.Core;

namespace ReiTunes.DevTools
{
    class Program
    {
        static async Task Main(string[] args)
        {
            // setx AZURE_STORAGE_CONNECTION_STRING "<yourconnectionstring>"
            var connectionString = Environment.GetEnvironmentVariable("AZURE_STORAGE_CONNECTION_STRING");
            var library = await GenerateLibrary(connectionString);
            Console.WriteLine(library);

            await WriteLibrary(connectionString, library);
            Console.WriteLine("finished writing");
        }

        static async Task<string> GenerateLibrary(string connectionString)
        {
            var ret = new StringBuilder();
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Constants.MusicContainerName);

            await foreach (BlobItem blobItem in containerClient.GetBlobsAsync())
            {
                ret.AppendLine(blobItem.Name);
            }

            return ret.ToString();
        }

        static async Task WriteLibrary(string connectionString, string libraryContents)
        {
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Constants.LibraryContainerName);
            BlobClient blobClient = containerClient.GetBlobClient(Constants.LibraryFileName);

            using (var libraryContentsStream = GenerateStreamFromString(libraryContents))
            {
                await blobClient.UploadAsync(libraryContentsStream, true);
            }
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
