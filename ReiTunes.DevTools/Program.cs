using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using ReiTunes.Core;
using Serilog.Core;
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace ReiTunes.DevTools {

    internal class Program {

        private static async Task Main(string[] args) {
            var client = new HttpClient();
            client.BaseAddress = new Uri("PLACEHOLDER");

            var caller = new ServerCaller(client, Logger.None);

            var sw = Stopwatch.StartNew();

            foreach (var item in items.Split(Environment.NewLine)) {
                Console.WriteLine(item);

                await caller.CreateNewLibraryItemAsync(item);
            }

            Console.WriteLine($"Took {sw.ElapsedMilliseconds}ms");
        }

        private static string items = @"Avalanches/01 DJ Set - Brains Party @ St Jerome.mp3
Avalanches/02 BeatsInSpace-04.01.14 Part2 with.mp3";

        private static async Task GenerateLibraryFromBlobStorage() {
            // setx AZURE_STORAGE_CONNECTION_STRING "<yourconnectionstring>"
            var connectionString = Environment.GetEnvironmentVariable("AZURE_STORAGE_CONNECTION_STRING");
            var library = await GenerateLibrary(connectionString);
            Console.WriteLine(library);

            await WriteLibrary(connectionString, library);
            Console.WriteLine("finished writing");
        }

        private static async Task<string> GenerateLibrary(string connectionString) {
            var ret = new StringBuilder();
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Core.Constants.MusicContainerName);

            await foreach (BlobItem blobItem in containerClient.GetBlobsAsync()) {
                ret.AppendLine(blobItem.Name);
            }

            return ret.ToString();
        }

        private static async Task WriteLibrary(string connectionString, string libraryContents) {
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Core.Constants.LibraryContainerName);
            BlobClient blobClient = containerClient.GetBlobClient(Core.Constants.LibraryFileName);

            using (var libraryContentsStream = GenerateStreamFromString(libraryContents)) {
                await blobClient.UploadAsync(libraryContentsStream, true);
            }
        }

        public static Stream GenerateStreamFromString(string s) {
            var stream = new MemoryStream();
            var writer = new StreamWriter(stream);
            writer.Write(s);
            writer.Flush();
            stream.Position = 0;
            return stream;
        }
    }
}