using Dapper;
using System.Data.SQLite;

namespace ReiTunes.Core {

    public static class SQLiteExtensions {

        public static long GetRowCount(this SQLiteConnection conn, string tableName) {
            return conn.QuerySingle<long>($"SELECT COUNT() FROM {tableName}");
        }
    }
}