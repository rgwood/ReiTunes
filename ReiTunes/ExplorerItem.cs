
using System.Collections.ObjectModel;
using System.ComponentModel;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=234238

namespace ReiTunes
{
    public class ExplorerItem : INotifyPropertyChanged
    {
        public event PropertyChangedEventHandler PropertyChanged;
        public enum ExplorerItemType { Folder, File };
        public string Name { get; set; }
        public ExplorerItemType Type { get; set; }
        private ObservableCollection<ExplorerItem> m_children;

        public ExplorerItem(string fileName, ExplorerItemType type = ExplorerItemType.File)
        {
            Name = fileName;
            Type = type;
        }

        public ObservableCollection<ExplorerItem> Children
        {
            get
            {
                if (m_children == null)
                {
                    m_children = new ObservableCollection<ExplorerItem>();
                }
                return m_children;
            }
            set
            {
                m_children = value;
            }
        }

        public static ObservableCollection<ExplorerItem> GetSampleData()
        {
            var ret = new ObservableCollection<ExplorerItem>();
            ExplorerItem folder = new ExplorerItem("SoundCloud DJ sets", ExplorerItemType.Folder)
            {
                Children =
                        {
                         new ExplorerItem("Between Villains (Earl Sweatshirt, Captain Murphy, MF DOOM)"),
                         new ExplorerItem("Daphni - 7.5 hr DJ Mix - Live from the Bussey Building. Oct 5, 2012. Part II"),
                         new ExplorerItem("Ingress - Burning Man Sunrise Set 2017"),
                         new ExplorerItem("Inversion - Burning Man Sunrise Set 2019")
                        }
            };
            ret.Add(folder);

            return new ObservableCollection<ExplorerItem>() { folder };
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
