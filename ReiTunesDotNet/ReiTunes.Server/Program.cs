using System.Diagnostics; // for Ben.Demystify
using ReiTunes.Core;
using ReiTunes.Server;
using Serilog;
using Serilog.Events;

if (args.Any() && args[0] == "install")
{
    await Systemd.InstallService();
    return;
}

var builder = WebApplication.CreateBuilder(args);

// Add DI services
builder.Services.AddControllers();
builder.Services.AddSingleton<ISerializedEventRepository, SQLiteEventRepository>(
    _ => new SQLiteEventRepository(SQLiteHelpers.CreateFileDb(Paths.LibraryDbPath)));
builder.Services.AddTransient<IClock, Clock>();
builder.Services.AddTransient<LibraryItemEventFactory>();

// Configure host (i.e. process-level stuff conceptually outside of ASP.NET)
Log.Logger = new LoggerConfiguration()
.MinimumLevel.Override("Microsoft", LogEventLevel.Information)
.Enrich.FromLogContext()
.WriteTo.Console()
.WriteTo.File(Paths.LogFilePath, rollingInterval: RollingInterval.Day)
.CreateLogger();
builder.Host.UseSerilog();
builder.Host.UseSystemd();

WebApplication app = builder.Build();

// set up HTTP
app.UseAuthorization();
app.MapControllers();

try
{
    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex.Demystify(), "Host terminated unexpectedly");
}
finally
{
    Log.CloseAndFlush();
}
