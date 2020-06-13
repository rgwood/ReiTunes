using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
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

        private Guid _id;

        public Guid Id {
            get { return _id; }
            set { Set(ref _id, value); }
        }

        //for deserialization
        public LibraryItem() {
        }

        public LibraryItem(string relativePath) {
            _id = Guid.NewGuid();
            _name = GetFileNameFromPath(relativePath);
            _fullPath = relativePath;
        }

        private string GetFileNameFromPath(string path) => path.Split('/').Last();
    }
}