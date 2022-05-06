using System.Diagnostics;
using CliWrap;
using Spectre.Console;

namespace Utils;

public static class Systemd
{
    /// <summary>
    /// Attempt to install the current process as a systemd service
    /// </summary>
    /// <returns>bool indicating whether the operation succeeded</returns>
    public static async Task<bool> InstallServiceAsync(string? name = null, string description = "")
    {
        string processPath = Environment.ProcessPath!;
        string processFileName = Path.GetFileName(processPath);
        string serviceName = name ?? processFileName;

        AnsiConsole.WriteLine($"Installing {processFileName} as a systemd service...");

        string user = TryGetUserFromPath(processPath) ?? "root";

        string unitFileContents = @$"[Unit]
Description={description}

[Service]
Type=simple
ExecStart={processPath}
User={user}
WorkingDirectory={Path.GetDirectoryName(processPath)}

[Install]
WantedBy=multi-user.target";

        string unitFilePath = $"/etc/systemd/system/{serviceName}.service";

        try
        {
            AnsiConsole.WriteLine("Writing unit file...");
            File.WriteAllText(unitFilePath, unitFileContents);
        }
        catch (Exception ex)
        {
            AnsiConsole.MarkupLine($"[red]Error:[/] write failed to {unitFilePath}. Did you forget to use sudo?");
            AnsiConsole.WriteException(ex.Demystify());
            return false;
        }

        try
        {
            AnsiConsole.WriteLine("Enabling service...");
            await Cli.Wrap("systemctl").WithArguments($"enable {serviceName}")
                .WithPipeToConsole().ExecuteAsync();

            AnsiConsole.WriteLine("Starting service...");
            await Cli.Wrap("systemctl").WithArguments($"start {serviceName}")
                .WithPipeToConsole().ExecuteAsync();
        }
        catch (Exception ex)
        {
            AnsiConsole.MarkupLine($"[red]Error:[/] failed to enable+start service");
            AnsiConsole.WriteException(ex.Demystify());
            return false;
        }

        AnsiConsole.MarkupLine($"[green]Done! Install succeeded.[/]");
        return true;
    }

    public static void Uninstall()
    {
        // TODO implement
        throw new NotImplementedException();
    }

    public static string? TryGetUserFromPath(string path)
    {
        path = path.Trim();
        var splitByPath = path.Split('/');

        if (splitByPath.Length <= 1)
            return null;
        if (splitByPath[0] == "" && splitByPath[1] == "root")
            return "root";
        if (splitByPath.Length <= 2)
            return null;
        if (splitByPath[0] == "" && splitByPath[1] == "home")
            return string.IsNullOrEmpty(splitByPath[2]) ? null : splitByPath[2];

        return null;
    }
}
