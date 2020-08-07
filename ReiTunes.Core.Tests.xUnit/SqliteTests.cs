using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Diagnostics.Contracts;
using System.Text;
using Xunit;

namespace ReiTunes.Core.Tests.xUnit {

    public class SqliteTests {

        private SQLiteConnection CreateInMemoryDb() => new SQLiteConnection("DataSource=:memory:");

        [Fact]
        private void CanCreateEmptyTable() {
            var conn = CreateInMemoryDb();
            conn.Open();
            using var cmd = new SQLiteCommand(conn);

            cmd.CommandText = @"CREATE TABLE IF NOT EXISTS priceData(id INTEGER PRIMARY KEY,
                    secId TEXT, price INT)";
            cmd.ExecuteNonQuery();

            cmd.CommandText = @"SELECT COUNT() FROM priceData";

            var count = (long)cmd.ExecuteScalar();

            Assert.Equal(0, count);

            //Assert.True(false);
        }
    }
}