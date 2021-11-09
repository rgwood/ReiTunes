using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;
using ReiTunes.Core;

namespace Benchmarker;

internal class Program {
    private static void Main(string[] args) {
        BenchmarkDotNet.Reports.Summary summary = BenchmarkRunner.Run<EventBenchmarker>();
    }
}

[MemoryDiagnoser]
[ShortRunJob]
public class EventBenchmarker {
    private Library _lib;
    private List<IEvent> _events;

    [GlobalSetup]
    public void Setup() {

        string libraryPath = @"C:\Users\reill\Music\library.db";
        var repo = new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
        var logger = LoggerHelpers.DoNothingLogger();
        _lib = new Library(Environment.MachineName, SQLiteHelpers.CreateFileDb(libraryPath), new NoopServerCaller(), logger);

        _events = repo.GetAllEvents().ToList();
    }

    [Benchmark]
    public SQLiteEventRepository OpenSqliteDbFromDisk() {
        string libraryPath = @"C:\Users\reill\Music\library.db";
        return new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
    }

    [Benchmark]
    public List<string> ReadAllEvents_RawJson() {
        string libraryPath = @"C:\Users\reill\Music\library.db";
        var repo = new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
        return repo.GetAllSerializedEvents().ToList();
    }

    [Benchmark]
    public List<IEvent> ReadAllEvents_Deserialized() {
        string libraryPath = @"C:\Users\reill\Music\library.db";
        var repo = new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
        return repo.GetAllEvents().ToList();
    }

    [Benchmark]
    public List<LibraryItem> ReplayAllEventsFromDisk() {
        string libraryPath = @"C:\Users\reill\Music\library.db";
        var repo = new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(libraryPath));
        var logger = LoggerHelpers.DoNothingLogger();
        var lib = new Library(Environment.MachineName, SQLiteHelpers.CreateFileDb(libraryPath), new NoopServerCaller(), logger);
        return lib.Items;
    }

    [Benchmark]
    public List<LibraryItem> ReplayAllEventsFromMemory() {
        _lib.RebuildItems(_events);
        return _lib.Items;
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