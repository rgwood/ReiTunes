using Dapper;
using FluentAssertions;
using ReiTunes.Core;
using System;
using System.ComponentModel.DataAnnotations;
using System.Data.SQLite;
using Xunit;

namespace Downloader {

    public class Program {
        public const string AudioType = "Audio";
        public const string VideoType = "Video";

        public class DownloadItem {
            public string Url { get; set; }
            public string Type { get; set; }
            public string CreatedTimestamp { get; set; }
        }

        private static void Main(string[] args) {
            // TODO: get DB from filesystem. Or args?
            var conn = SQLiteHelpers.CreateInMemoryDb();
            CreateTablesIfNotExists(conn);

            var item = PopQueue(conn);

            if (item != null) {
                try {
                    // TODO: implement download

                    InsertToFinished(conn, item);
                }
                catch (Exception ex) {
                    InsertToDeadLetter(conn, item, ex);
                }
            }
        }

        private static DownloadItem PopQueue(SQLiteConnection conn) {
            var item = conn.QuerySingleOrDefault<DownloadItem>("select * from queue LIMIT 1;");

            if (item != null) {
                conn.Execute("delete from queue where url = @Url", new { item.Url });
            }

            return item;
        }

        private static void InsertUrlToQueue(SQLiteConnection conn, string url, string type) {
            conn.Execute("insert into queue(Url, Type) values(@url, @type)", new { url, type });
        }

        private static void InsertToFinished(SQLiteConnection conn, DownloadItem item) {
            conn.Execute("insert into finished(Url, Type, CreatedTimestamp) values(@Url, @Type, @CreatedTimestamp)",
                new { item.Url, item.Type, item.CreatedTimestamp });
        }

        private static void InsertToDeadLetter(SQLiteConnection conn, DownloadItem item, Exception ex) {
            conn.Execute("insert into deadLetter(Url, Type, CreatedTimestamp, Exception) values(@Url, @Type, @CreatedTimestamp, @Ex)",
                new { item.Url, item.Type, item.CreatedTimestamp, Ex = ex.ToString() });
        }

        private static void CreateTablesIfNotExists(SQLiteConnection conn) {
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
    Url TEXT PRIMARY KEY NOT NULL,
    Type TEXT NOT NULL,
    CreatedTimestamp TEXT NOT NULL,
    FinishedTimestamp TEXT DEFAULT CURRENT_TIMESTAMP
)");
            conn.Execute(@"
CREATE TABLE IF NOT EXISTS
deadLetter(
    Url TEXT PRIMARY KEY NOT NULL,
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

            InsertUrlToQueue(db, urlToUse, AudioType);

            db.ExecuteScalar<int>("select count(*) from queue").Should().Be(1);

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

            InsertUrlToQueue(db, urlToUse, AudioType);

            var item = PopQueue(db);

            InsertToDeadLetter(db, item, new NullReferenceException());

            db.ExecuteScalar<int>("select count(*) from deadLetter").Should().Be(1);
        }
    }
}