using ReiTunes.Core;

// TODO can we calculate 2b3c53fd-b804-4e1e-b26c-cae302ea1108_hmppzwgz807yp instead of hardcoding it here?
string libraryPath = Environment.ExpandEnvironmentVariables(@"%USERPROFILE%\AppData\Local\Packages\2b3c53fd-b804-4e1e-b26c-cae302ea1108_hmppzwgz807yp\LocalState\library.db");
SQLiteEventRepository repo = new(SQLiteHelpers.CreateFileDb(libraryPath));
Library lib = new(SQLiteHelpers.CreateFileDb(libraryPath), LoggerHelpers.DoNothingLogger(), new NoopServerCaller());

foreach (LibraryItem item in lib.Items) {
    if(string.IsNullOrEmpty(item.Album))
        Console.WriteLine($"{item.AggregateId}\t{item.Name} - {item.Artist}");
    else
        Console.WriteLine($"{item.AggregateId}\t{item.Name} - {item.Artist} - {item.Album}");
}