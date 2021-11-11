using Serilog;
using Serilog.Events;

namespace ReiTunes.Server;

public class Program
{

    public static int Main(string[] args)
    {
        Log.Logger = new LoggerConfiguration()
        .MinimumLevel.Override("Microsoft", LogEventLevel.Information)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.File(Paths.LogFilePath, rollingInterval: RollingInterval.Day)
        .CreateLogger();

        try
        {
            Log.Information("Starting web host");
            CreateHostBuilder(args).Build().Run();
            return 0;
        }
        catch (Exception ex)
        {
            Log.Fatal(ex, "Host terminated unexpectedly");
            return 1;
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .UseSerilog()
            .UseSystemd()
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
