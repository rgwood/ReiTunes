
using System.Collections.ObjectModel;
using System.ComponentModel;

namespace ReiTunes
{
    public class FileTreeItem : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;
        public string Name { get; set; }
        public string FullPath { get; set; }
        public FileTreeItemType Type { get; set; }
        private ObservableCollection<FileTreeItem> _children;

        public FileTreeItem(string fileName, string fullPath,  FileTreeItemType type = FileTreeItemType.File)
        {
            Name = fileName;
            FullPath = fullPath;
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
