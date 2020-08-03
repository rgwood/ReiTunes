using Microsoft.Toolkit.Uwp.UI.Controls;
using ReiTunes.Core;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Windows.UI.Popups;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Controls.Primitives;
using Windows.UI.Xaml.Data;
using Windows.UI.Xaml.Input;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Navigation;

// The Blank Page item template is documented at https://go.microsoft.com/fwlink/?LinkId=402352&clcid=0x409

namespace EventSourcingTester {

    /// <summary>
    /// An empty page that can be used on its own or navigated to within a Frame.
    /// </summary>
    public sealed partial class MainPage : Page {
        public ReiTunesApplication app1;
        public ReiTunesApplication app2;
        public ReiTunesApplication server;

        private Guid sharedGuid;

        public MainPage() {
            this.InitializeComponent();
            sharedGuid = Guid.NewGuid();
            app1 = new ReiTunesApplication("client1");
            app2 = new ReiTunesApplication("client2");
            server = new ReiTunesApplication("server");
        }

        private void App1_AddClick(object sender, RoutedEventArgs e) {
            var agg = new LibraryItem("foo.mp3");
            app1.Models.Add(agg);
            app1.Commit();
        }

        private void App1_IncrementClick(object sender, RoutedEventArgs e) {
            app1.Models.First().IncrementPlayCount();
            app1.Commit();
        }

        private async void App1_PullClick(object sender, RoutedEventArgs e) {
            app1.ReceiveEvents(server.GetAllEvents());
        }

        private async void App1_PushClick(object sender, RoutedEventArgs e) {
            server.ReceiveEvents(app1.GetAllEvents());
        }

        private void App1_RebuildClick(object sender, RoutedEventArgs e) {
            app1.RebuildModels();
        }

        private void App1_ViewEventsClick(object sender, RoutedEventArgs e) {
            var events = app1.GetAllEvents().Select(ev => EventSerialization.Serialize(ev));
            EventsTextBlock.Text = string.Join(Environment.NewLine, events);
        }

        private void DataGrid1_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            app1.Commit();
        }

        private void app1_Sorting(object sender, DataGridColumnEventArgs e) {
            //Use the Tag property to pass the bound column name for the sorting implementation
            if (e.Column.Tag.ToString() == nameof(LibraryItem.Name)) {
                if (e.Column.SortDirection == null || e.Column.SortDirection == DataGridSortDirection.Descending) {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.Name ascending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Ascending;
                }
                else {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.Name descending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Descending;
                }
            }

            if (e.Column.Tag.ToString() == nameof(LibraryItem.PlayCount)) {
                if (e.Column.SortDirection == null || e.Column.SortDirection == DataGridSortDirection.Descending) {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.PlayCount ascending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Ascending;
                }
                else {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.PlayCount descending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Descending;
                }
            }

            if (e.Column.Tag.ToString() == nameof(LibraryItem.Artist)) {
                if (e.Column.SortDirection == null || e.Column.SortDirection == DataGridSortDirection.Descending) {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.Artist ascending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Ascending;
                }
                else {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.Artist descending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Descending;
                }
            }

            if (e.Column.Tag.ToString() == nameof(LibraryItem.Album)) {
                if (e.Column.SortDirection == null || e.Column.SortDirection == DataGridSortDirection.Descending) {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.Album ascending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Ascending;
                }
                else {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.Album descending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Descending;
                }
            }

            if (e.Column.Tag.ToString() == nameof(LibraryItem.CreatedTimeUtc)) {
                if (e.Column.SortDirection == null || e.Column.SortDirection == DataGridSortDirection.Descending) {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.CreatedTimeUtc ascending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Ascending;
                }
                else {
                    DataGrid1.ItemsSource = new ObservableCollection<LibraryItem>(from item in app1.Models
                                                                                  orderby item.CreatedTimeUtc descending
                                                                                  select item);
                    e.Column.SortDirection = DataGridSortDirection.Descending;
                }
            }
            // add code to handle sorting by other columns as required

            // Remove sorting indicators from other columns
            foreach (var dgColumn in DataGrid1.Columns) {
                if (dgColumn.Tag.ToString() != e.Column.Tag.ToString()) {
                    dgColumn.SortDirection = null;
                }
            }
        }

        private void App2_AddClick(object sender, RoutedEventArgs e) {
            var agg = new LibraryItem("bar.mp3");
            app2.Models.Add(agg);
            app2.Commit();
        }

        private void App2_IncrementClick(object sender, RoutedEventArgs e) {
            app2.Models.First().IncrementPlayCount();
            app2.Commit();
        }

        private void App2_PullClick(object sender, RoutedEventArgs e) {
            app2.ReceiveEvents(server.GetAllEvents());
        }

        private void App2_PushClick(object sender, RoutedEventArgs e) {
            server.ReceiveEvents(app2.GetAllEvents());
        }

        private void App2_ViewEventsClick(object sender, RoutedEventArgs e) {
            var events = app2.GetAllEvents().Select(ev => EventSerialization.Serialize(ev));
            EventsTextBlock.Text = string.Join(Environment.NewLine, events);
        }

        private void DataGrid2_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            app2.Commit();
        }

        private void DataGridServer_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            server.Commit();
        }

        private void Server_ViewEventsClick(object sender, RoutedEventArgs e) {
            var events = server.GetAllEvents().Select(ev => EventSerialization.Serialize(ev));
            EventsTextBlock.Text = string.Join(Environment.NewLine, events);
        }
    }
}