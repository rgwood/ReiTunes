using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;
using ReiTunes.Core;
using System.Collections.Generic;
using System.Linq;

namespace Benchmarker {

    internal class Program {

        private static void Main(string[] args) {
            BenchmarkDotNet.Reports.Summary summary = BenchmarkRunner.Run<EventBenchmarker>();
        }
    }

    [MemoryDiagnoser]
    public class EventBenchmarker {

        [Benchmark]
        public SQLiteEventRepository OpenDb() {

            string libraryPath = @"C:\Users\reill\Music\library.db";
            return new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
        }

        [Benchmark]
        public List<IEvent> OpenDbAndGetAllEvents() {
            string libraryPath = @"C:\Users\reill\Music\library.db";
            var repo = new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
            return repo.GetAllEvents().ToList();
        }

        [Benchmark]
        public List<LibraryItem> ReplayAllEventsFromDisk() {
            string libraryPath = @"C:\Users\reill\Music\library.db";
            var repo = new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
            var logger = LoggerHelpers.DoNothingLogger();
            var lib = new Library(SQLiteHelpers.CreateFileDb(libraryPath), logger);
            return lib.Items;
        }
    }

    [MemoryDiagnoser]
    public class MemoryBenchmarker {

        [Benchmark]
        public List<byte[]> Allocate() {
            List<byte[]> ret = new List<byte[]>();

            for (int i = 0; i < 1024; i++) {
                ret.Add(OneMegabyte());
            }

            return ret;
        }

        public static byte[] OneMegabyte() {
            return new byte[1024 * 1024];
        }
    }
}