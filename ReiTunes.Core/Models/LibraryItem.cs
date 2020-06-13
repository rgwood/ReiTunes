using System.Collections.ObjectModel;
using System.ComponentModel;
using ReiTunes.Core;

namespace ReiTunes.Core {

    public class LibraryItem : Observable {
        private string _name;

        public string Name {
            get { return _name; }
            set { Set(ref _name, value); }
        }

        private string _fullPath;

        public string FullPath {
            get { return _fullPath; }
            set { Set(ref _fullPath, value); }
        }

        public LibraryItem(string fileName, string fullPath) {
            _name = fileName;
            _fullPath = fullPath;
        }
    }
}