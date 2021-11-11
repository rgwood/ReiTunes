namespace ReiTunes.Core;

public static class StringHelpers
{

    // Use Rune instead of this once we're able to be on .NET Core 3.1 and above
    public static List<string> TextElements(this string input)
    {
        System.Globalization.TextElementEnumerator enumerator = System.Globalization.StringInfo.GetTextElementEnumerator(input);
        List<string> list = new List<string>();
        while (enumerator.MoveNext())
        {
            list.Add(enumerator.GetTextElement());
        }
        return list;
    }
}
