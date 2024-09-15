using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;

class Program
{
    static async Task Main()
    {
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Add("x-api-key", Environment.GetEnvironmentVariable("REITUNES_API_KEY"));
        var content = JsonContent.Create(new { file_path = "file.mp3" });
        await client.PostAsync($"{Environment.GetEnvironmentVariable("URL_SCHEME")}://{Environment.GetEnvironmentVariable("REITUNES_HOSTNAME")}/api/add", content);
    }
}
