using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;
using System.Collections.Generic;

namespace Benchmarker {

    internal class Program {

        private static void Main(string[] args) {
            BenchmarkDotNet.Reports.Summary summary = BenchmarkRunner.Run<MemoryBenchmarker>();
        }
    }

    [MemoryDiagnoser]
    public class MemoryBenchmarker {

        [Benchmark]
        public List<byte[]> Allocate() {
            List<byte[]> ret = new List<byte[]>();

            for (int i = 0; i < 1024; i++) {
                ret.Add(OneMegabyte());
            }

            return ret;
        }

        public static byte[] OneMegabyte() {
            return new byte[1024 * 1024];
        }
    }
}