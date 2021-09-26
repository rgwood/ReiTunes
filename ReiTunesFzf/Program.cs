using ReiTunes.Core;

// TODO find a way to get the packaged app path...
// this is not the normal location of the library.db file
string libraryPath = Environment.ExpandEnvironmentVariables(@"%USERPROFILE%\Music\library.db");
SQLiteEventRepository repo = new(SQLiteHelpers.CreateFileDb(libraryPath));
Library lib = new(SQLiteHelpers.CreateFileDb(libraryPath), LoggerHelpers.DoNothingLogger());

foreach (LibraryItem item in lib.Items) {
    if(string.IsNullOrEmpty(item.Album))
        Console.WriteLine($"{item.AggregateId}\t{item.Name} - {item.Artist}");
    else
        Console.WriteLine($"{item.AggregateId}\t{item.Name} - {item.Artist} - {item.Album}");
}