using Dapper;
using System.Data.SQLite;

namespace ReiTunes.Core {

    public static class SQLiteHelpers {

        public static long GetRowCount(this SQLiteConnection conn, string tableName) {
            return conn.QuerySingle<long>($"SELECT COUNT() FROM {tableName}");
        }

        public static SQLiteConnection CreateInMemoryDb() {
            var connection = new SQLiteConnection("DataSource=:memory:");
            connection.Open();
            return connection;
        }
    }
}