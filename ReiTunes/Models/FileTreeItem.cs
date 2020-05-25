
using System.Collections.ObjectModel;
using System.ComponentModel;

namespace ReiTunes
{
    public class FileTreeItem : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;
        public string Name { get; set; }
        public FileTreeItemType Type { get; set; }
        private ObservableCollection<FileTreeItem> _children;

        // Needed for JSON deserialization
        public FileTreeItem()
        {
        }

        public FileTreeItem(string fileName, FileTreeItemType type = FileTreeItemType.File)
        {
            Name = fileName;
            Type = type;
        }

        public ObservableCollection<FileTreeItem> Children
        {
            get
            {
                if (_children == null)
                {
                    _children = new ObservableCollection<FileTreeItem>();
                }
                return _children;
            }
            set
            {
                _children = value;
            }
        }

        public static ObservableCollection<FileTreeItem> GetSampleData()
        {
            var ret = new ObservableCollection<FileTreeItem>();
            FileTreeItem folder = new FileTreeItem("SoundCloud DJ sets", FileTreeItemType.Folder)
            {
                Children =
                        {
                         new FileTreeItem("Between Villains (Earl Sweatshirt, Captain Murphy, MF DOOM)"),
                         new FileTreeItem("Daphni - 7.5 hr DJ Mix - Live from the Bussey Building. Oct 5, 2012. Part II"),
                         new FileTreeItem("Ingress - Burning Man Sunrise Set 2017"),
                         new FileTreeItem("Inversion - Burning Man Sunrise Set 2019")
                        }
            };
            ret.Add(folder);

            return new ObservableCollection<FileTreeItem>() { folder };
        }

        private bool m_isExpanded;
        public bool IsExpanded
        {
            get { return m_isExpanded; }
            set
            {
                if (m_isExpanded != value)
                {
                    m_isExpanded = value;
                    NotifyPropertyChanged("IsExpanded");
                }
            }
        }

        private bool m_isSelected;
        public bool IsSelected
        {
            get { return m_isSelected; }

            set
            {
                if (m_isSelected != value)
                {
                    m_isSelected = value;
                    NotifyPropertyChanged("IsSelected");
                }
            }

        }

        private void NotifyPropertyChanged(string propertyName)
        {
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
        }
    }
}
