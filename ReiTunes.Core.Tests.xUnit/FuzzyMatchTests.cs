using ReiTunes.Core;
using System.Collections.Generic;
using Xunit;
using System;
using System.Linq;
using FluentAssertions;
using NuGet.Frameworks;
using System.Diagnostics;
using System.Collections;
using Microsoft.Data.Sqlite;
using Serilog.Core;

namespace ReiTunes.Core.Tests.XUnit {

    public class FuzzyMatchTests {

        [Fact]
        public void FuzzyMatchWorks_Basic() {
            var goodResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "rei");
            Assert.True(goodResult.isMatch);

            var badResult = FuzzyMatcher.FuzzyMatch("Reilly Wood", "xcv");
            Assert.False(badResult.isMatch);

            Assert.True(goodResult.score > badResult.score);
        }

        [Fact]
        public void FuzzyMatchGivesReasonableResult_Bonobo() {
            var desired = "Solid Steel Radio Show 6_1_2012 Part 1 + 2 Bonobo Solid Steel Radio Show Solid Steel Radio/Solid Steel Radio Show 6_1_2012 Part 1 + 2 - Bonobo.mp3";
            var notDesired = "Breezeblock 2001-02-26 The Avalanches The Breezeblock Avalanches/The Avalanches on Radio 1 Breezebloc.mp3";

            TestFuzzyMatch(desired, notDesired, "bonobo");
            TestFuzzyMatch(desired, notDesired, "bonob");
        }

        [Fact]
        public void FuzzyMatchGivesReasonableResult_Metal() {
            var desired = "Special Herbs (Volume 1 & 2) Metal Fingers.mp3";
            var notDesired = "GIMIX Mixtape The Avalanches Avalanches/The Avalanches .mp3";

            TestFuzzyMatch(desired, notDesired, "metal");
            TestFuzzyMatch(desired, notDesired, "meta");
        }

        private void TestFuzzyMatch(string desiredItem, string notDesiredItem, string searchText) {
            var desiredItemResult = FuzzyMatcher.FuzzyMatch(desiredItem, searchText);
            var notDesiredItemResult = FuzzyMatcher.FuzzyMatch(notDesiredItem, searchText);

            desiredItemResult.score.Should().BeGreaterThan(notDesiredItemResult.score);
        }
    }
}