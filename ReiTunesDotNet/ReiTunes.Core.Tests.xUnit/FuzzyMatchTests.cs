using FluentAssertions;
using Xunit;

namespace ReiTunes.Core.Tests.XUnit;

public class FuzzyMatchTests
{

    [Fact]
    public void FuzzyMatchWorks_Basic()
    {
        (bool isMatch, int score) goodResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "rei");
        Assert.True(goodResult.isMatch);

        (bool isMatch, int score) badResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "xcv");
        Assert.False(badResult.isMatch);

        Assert.True(goodResult.score > badResult.score);
    }

    [Fact]
    public void FuzzyMatchGivesReasonableResult_Bonobo()
    {
        string desired = "Solid Steel Radio Show 6_1_2012 Part 1 + 2 Bonobo Solid Steel Radio Show Solid Steel Radio/Solid Steel Radio Show 6_1_2012 Part 1 + 2 - Bonobo.mp3";
        string notDesired = "Breezeblock 2001-02-26 The Avalanches The Breezeblock Avalanches/The Avalanches on Radio 1 Breezebloc.mp3";

        TestFuzzyMatch(desired, notDesired, "bonobo");
        TestFuzzyMatch(desired, notDesired, "bonob");
    }

    [Fact]
    public void FuzzyMatchGivesReasonableResult_Metal()
    {
        string desired = "Special Herbs (Volume 1 & 2) Metal Fingers.mp3";
        string notDesired = "GIMIX Mixtape The Avalanches Avalanches/The Avalanches .mp3";

        TestFuzzyMatch(desired, notDesired, "metal");
        TestFuzzyMatch(desired, notDesired, "meta");
    }

    private static void TestFuzzyMatch(string desiredItem, string notDesiredItem, string searchText)
    {
        (bool isMatch, int score) desiredItemResult = FuzzyMatcher.FuzzyMatch(desiredItem, searchText);
        (bool isMatch, int score) notDesiredItemResult = FuzzyMatcher.FuzzyMatch(notDesiredItem, searchText);

        desiredItemResult.score.Should().BeGreaterThan(notDesiredItemResult.score);
    }
}
