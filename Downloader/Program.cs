using Azure.Storage.Blobs;
using Dapper;
using FluentAssertions;
using Microsoft.Data.Sqlite;
using ReiTunes.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace Downloader {

    public class Program {
        private const string YoutubeDlPath = "/usr/local/bin/youtube-dl";
        private const string QueueDbFilePath = "/mnt/QNAP1/Downloads/Music/downloadQueue.db";

        private enum DlType {
            Audio,
            Video,
            Logs
        }

        private record DownloadItem(string Url, DlType Type, string CreatedTimestamp);
        private record CommandResult(IEnumerable<string> stdout, IEnumerable<string> stderr);

        private static void Main(string[] args) {
            // TODO: get DB from filesystem. Or args?
            var conn = SQLiteHelpers.CreateFileDb(QueueDbFilePath);
            CreateTablesIfNotExists(conn);

            var item = PopQueue(conn);

            if (item != null) {
                Console.WriteLine($"About to attempt download for: {item}");
                try {
                    Download(item.Url, item.Type);
                    Console.WriteLine("Download finished");
                    InsertToFinished(conn, item);

                    if (item.Type == DlType.Audio) {
                        Console.WriteLine($"Uploading to ReiTunes");
                        // TODO: Download should return a file name so we don't need to look it up again
                        Console.WriteLine($"Retrieving file name...");
                        var fileName = GetFileName(item.Url, DlType.Audio);
                        Console.WriteLine($"Retrieved file name: {fileName}");

                        var filePath = Path.Combine(WorkingDirectory(item.Type), fileName);
                        Console.WriteLine($"About to upload {filePath}");

                        Upload(filePath, fileName);
                        Console.WriteLine($"Upload Finished");
                    }
                }
                catch (Exception ex) {
                    Console.WriteLine("Failed :(");
                    Console.WriteLine(ex.ToString());
                    InsertToDeadLetter(conn, item, ex);
                }
            }
        }

        private static void Upload(string localFilePath, string remoteFileName) {
            BlobServiceClient blobServiceClient = new BlobServiceClient(Secrets.AzureStorageConnectionString);
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(Constants.MusicContainerName);

            BlobClient blobClient = containerClient.GetBlobClient(remoteFileName);
            using FileStream uploadFileStream = File.OpenRead(localFilePath);
            blobClient.Upload(uploadFileStream, true);
            uploadFileStream.Close();
        }

        private static string WorkingDirectory(DlType type) => type switch {
            DlType.Audio => "/mnt/QNAP1/Downloads/Music/",
            DlType.Video => "/mnt/QNAP1/Downloads/YouTube/",
            DlType.Logs => "/mnt/QNAP1/Logs/YTDL/",
            _ => throw new ArgumentOutOfRangeException($"WorkingDirectory not implemented for type'{type}")
        };

        private static string Arguments(DlType type, string url) => type switch {
            DlType.Audio => $"--extract-audio --audio-format mp3 -- {url}",
            _ => url,
        };

        private static CommandResult Download(string url, DlType type) {
            string workingDirectory = WorkingDirectory(type);
            string arguments = Arguments(type, url);
            return RunYTDL(arguments, workingDirectory);
        }

        private static CommandResult RunYTDL(string arguments, string workingDirectory) {
            var stdout = new List<string>();
            var stderr = new List<string>();

            using var process = new System.Diagnostics.Process();
            process.StartInfo.FileName = YoutubeDlPath;

            process.StartInfo.Arguments = arguments;
            process.StartInfo.WorkingDirectory = workingDirectory;

            process.StartInfo.CreateNoWindow = true;
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;

            process.OutputDataReceived += (sender, data) => {
                Console.WriteLine(data.Data);
                stdout.Add(data.Data);
            };
            process.ErrorDataReceived += (sender, data) => {
                Console.WriteLine(data.Data);
                stderr.Add(data.Data);
            };

            Console.WriteLine("[YOUTUBE-DL] STARTING...");

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();

            Console.WriteLine($"[YOUTUBE-DL] DONE!");

            if (process.ExitCode != 0) {
                throw new Exception($"Youtube-dl failed, exit code {process.ExitCode}");
            }

            return new CommandResult(stdout, stderr);
        }

        // TODO: test this and use it to upload files
        private static string GetFileName(string url, DlType type) {
            var result = RunYTDL($"--get-filename -- {url}", WorkingDirectory(type));
            var fileName = result.stdout.First();
            return type == DlType.Audio ? RenameToMp3(fileName) : fileName;
        }

        private static string RenameToMp3(string filePath) => Path.ChangeExtension(filePath, "mp3");

        [Fact]
        public void RenameTests() {
            RenameToMp3("foo.bar").Should().Be("foo.mp3");
            RenameToMp3("foo.mp3").Should().Be("foo.mp3");
        }

        private static DownloadItem PopQueue(SqliteConnection conn) {
            var item = conn.QuerySingleOrDefault<DownloadItem>("select * from queue LIMIT 1;");

            if (item != null) {
                conn.Execute("delete from queue where url = @Url", new { item.Url });
            }

            return item;
        }

        private static void InsertUrlToQueue(SqliteConnection conn, string url, DlType type) {
            conn.Execute("insert into queue(Url, Type) values(@url, @type)", new { url, type = type.ToString() });
        }

        private static void InsertToFinished(SqliteConnection conn, DownloadItem item) {
            conn.Execute("insert into finished(Url, Type, CreatedTimestamp) values(@Url, @Type, @CreatedTimestamp)",
                new { item.Url, item.Type, item.CreatedTimestamp });
        }

        private static void InsertToDeadLetter(SqliteConnection conn, DownloadItem item, Exception ex) {
            conn.Execute("insert into deadLetter(Url, Type, CreatedTimestamp, Exception) values(@Url, @Type, @CreatedTimestamp, @Ex)",
                new { item.Url, item.Type, item.CreatedTimestamp, Ex = ex.ToString() });
        }

        private static void CreateTablesIfNotExists(SqliteConnection conn) {
            conn.Execute(@"
CREATE TABLE IF NOT EXISTS
queue(
    Url TEXT PRIMARY KEY NOT NULL,
    Type TEXT NOT NULL,
    CreatedTimestamp TEXT DEFAULT CURRENT_TIMESTAMP
)");

            conn.Execute(@"
CREATE TABLE IF NOT EXISTS
finished(
    Url TEXT NOT NULL,
    Type TEXT NOT NULL,
    CreatedTimestamp TEXT NOT NULL,
    FinishedTimestamp TEXT DEFAULT CURRENT_TIMESTAMP
)");
            conn.Execute(@"
CREATE TABLE IF NOT EXISTS
deadLetter(
    Url TEXT NOT NULL,
    Type TEXT NOT NULL,
    CreatedTimestamp TEXT NOT NULL,
    Exception TEXT,
    FinishedTimestamp TEXT DEFAULT CURRENT_TIMESTAMP
)");
        }

        [Fact]
        public void CanInitializeDb() {
            var db = SQLiteHelpers.CreateInMemoryDb();
            CreateTablesIfNotExists(db);
        }

        [Fact]
        public void AudioQueueWorks() {
            const string urlToUse = "http://reillywood.com/song.mp3";

            var db = SQLiteHelpers.CreateInMemoryDb();
            CreateTablesIfNotExists(db);

            var item = PopQueue(db);
            item.Should().BeNull();

            InsertUrlToQueue(db, urlToUse, DlType.Audio);

            db.ExecuteScalar<int>("select count(*) from queue").Should().Be(1);
            db.ExecuteScalar<string>("select Type from queue").Should().Be("Audio");

            item = PopQueue(db);
            item.Url.Should().Be(urlToUse);

            PopQueue(db).Should().BeNull();

            InsertToFinished(db, item);

            db.ExecuteScalar<int>("select count(*) from queue").Should().Be(0);
            db.ExecuteScalar<int>("select count(*) from finished").Should().Be(1);
        }

        [Fact]
        public void DeadLetterQueueWorks() {
            const string urlToUse = "http://reillywood.com/song.mp3";

            var db = SQLiteHelpers.CreateInMemoryDb();
            CreateTablesIfNotExists(db);

            InsertUrlToQueue(db, urlToUse, DlType.Audio);

            var item = PopQueue(db);

            InsertToDeadLetter(db, item, new NullReferenceException());

            db.ExecuteScalar<int>("select count(*) from deadLetter").Should().Be(1);

            InsertToDeadLetter(db, item, new NullReferenceException());

            db.ExecuteScalar<int>("select count(*) from deadLetter").Should().Be(2);
        }
    }
}