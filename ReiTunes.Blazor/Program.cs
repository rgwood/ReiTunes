using Microsoft.Data.Sqlite;
using Microsoft.Extensions.FileProviders;
using ReiTunes.Blazor;
using ReiTunes.Core;
using Serilog;
using Utils;

if (args.Any() && args[0] == "install")
{
    await Systemd.InstallServiceAsync("reitunes");
    return;
}

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

builder.Services.AddHttpClient();

builder.Logging.ClearProviders();

// TODO: log to file
var serilog = new LoggerConfiguration()
    .WriteTo.Console()
    .CreateLogger();
builder.Logging.AddSerilog(serilog);

builder.Services.AddSingleton<Serilog.ILogger>(serilog);
builder.Services.AddSingleton<ServerCaller>();

builder.Services.AddBlazorContextMenu();

var libraryFilePath = Environment.ExpandEnvironmentVariables("%HOME%/Music/ReiTunes/library.db");
var musicFileDirPath = Environment.ExpandEnvironmentVariables("%HOME%/Music/ReiTunes/");

// create the music file directory if it doesn't exist
if (!Directory.Exists(musicFileDirPath))
{
    Directory.CreateDirectory(musicFileDirPath);
}

builder.Services.AddSingleton<SqliteConnection>((_) => SQLiteHelpers.CreateFileDb(libraryFilePath));
// builder.Services.AddSingleton<Library>();

// doing the provider song-and-dance to pick a specific constructor
builder.Services.AddSingleton<Library>(provider =>
    new Library(
        provider.GetRequiredService<SqliteConnection>(),
        provider.GetRequiredService<Serilog.ILogger>(),
        provider.GetRequiredService<ServerCaller>()));

builder.Services.AddSingleton<LibrarySettings>(_ => new LibrarySettings(musicFileDirPath));

var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(Environment.ExpandEnvironmentVariables("%HOME%/Music/ReiTunes")),
    RequestPath = "/musiclibrary",
});

app.UseStaticFiles();

app.UseRouting();

app.MapBlazorHub();
app.MapFallbackToPage("/_Host");



app.Run();
