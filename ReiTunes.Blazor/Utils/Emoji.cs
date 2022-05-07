namespace Utils;

public static class Emoji
{

    public static readonly string[] MusicEmojis = {"🎹","🎵","🎶"};

    public static string RandomEmoji() => MusicEmojis[Random.Shared.Next(0, MusicEmojis.Length)];


    public static string Blingify(string input)
    {
        var emoji = RandomEmoji();
        return $"{emoji} {input} {emoji}";
    }

}
