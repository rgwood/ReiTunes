using Microsoft.Data.Sqlite;
using ReiTunes.Blazor;
using ReiTunes.Core;
using Serilog;

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

var libraryFilePath = Environment.ExpandEnvironmentVariables("%HOME%/.local/share/reitunes/library.db");
builder.Services.AddSingleton<SqliteConnection>((_) => SQLiteHelpers.CreateFileDb(libraryFilePath));
// builder.Services.AddSingleton<Library>();

// doing the provider song-and-dance to pick a specific constructor
builder.Services.AddSingleton<Library>(provider =>
    new Library(
        provider.GetRequiredService<SqliteConnection>(),
        provider.GetRequiredService<Serilog.ILogger>(),
        provider.GetRequiredService<ServerCaller>()));

builder.Services.AddHostedService<LibraryService>();

var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();

app.UseStaticFiles();

app.UseRouting();

app.MapBlazorHub();
app.MapFallbackToPage("/_Host");



app.Run();
