using System.Net.Http;
using System.Threading.Tasks;

class Program
{
    static async Task Main()
    {
        using var client = new HttpClient();
        client.DefaultRequestHeaders.Add("x-api-key", Environment.GetEnvironmentVariable("REITUNES_API_KEY"));
        await client.PostAsync($"{Environment.GetEnvironmentVariable("URL_SCHEME")}://{Environment.GetEnvironmentVariable("REITUNES_HOSTNAME")}/api/add", new FormUrlEncodedContent(new[] { new KeyValuePair<string, string>("file_path", "file.mp3") }));
    }
}
