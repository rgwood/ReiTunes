using System;
using System.Threading;

namespace ReiTunes.Core
{

    public interface IClock
    {

        public long GetNextLocalId();

        public DateTime Now();
    }

    public class Clock : IClock
    {

        // Resets to zero every time the event factory is created. This is good enough for my needs right now but
        // maybe we should persist this?
        private long _currentLocalId;

        public long GetNextLocalId() => Interlocked.Increment(ref _currentLocalId);

        public DateTime Now() => DateTime.UtcNow;
    }

    // Useful for tests, will always get a different Now() time even if called immediately after each other
    public class AlwaysIncreasingClock : IClock
    {
        private static DateTime _now = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static readonly object _nowLock = new object();

        private long _currentLocalId;

        public long GetNextLocalId() => Interlocked.Increment(ref _currentLocalId);

        public DateTime Now()
        {
            lock (_nowLock)
            {
                _now = _now.AddDays(1);
                return _now;
            }
        }
    }

    // Useful for tests, will always get the same time. Simulate multiple events occurring so quickly that they get the same timestamp
    public class NeverIncreasingClock : IClock
    {
        private static readonly DateTime _now = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        private long _currentLocalId;

        public long GetNextLocalId() => Interlocked.Increment(ref _currentLocalId);

        public DateTime Now() => _now;
    }

    // Same as above but also hold the local ID constant
    public class NeverEverIncreasingClock : IClock
    {
        private const int UnchangingLocalId = 0;
        private static readonly DateTime _now = new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public long GetNextLocalId() => UnchangingLocalId;

        public DateTime Now() => _now;
    }
}