using System.Collections.ObjectModel;
using System.ComponentModel;
using ReiTunes.Core;

namespace ReiTunes.Core
{
    public class LibraryItem : Observable
    {
        public event PropertyChangedEventHandler PropertyChanged;

        public string Name { get; set; }
        public string FullPath { get; set; }

        public LibraryItem(string fileName, string fullPath)
        {
            Name = fileName;
            FullPath = fullPath;
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