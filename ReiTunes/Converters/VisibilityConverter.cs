using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Windows.UI.Xaml;

namespace ReiTunes.Core.Converters {

    public class VisibilityConverter : IValueConverter {

        public static Visibility VisibilityFromBool(bool a) =>
            a ? Visibility.Visible : Visibility.Collapsed;

        public static Visibility VisibilityOrFromBools(bool a, bool b) =>
            (a || b) ? Visibility.Visible : Visibility.Collapsed;

        public static double OpacityFromBool(bool a) =>
            a ? 1 : 0;

        public static double OpacityOrFromBools(bool a, bool b) =>
            (a || b) ? 1 : 0;
    }
}