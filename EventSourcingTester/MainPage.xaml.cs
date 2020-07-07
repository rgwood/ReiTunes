using ReiTunes.Core;
using System;
using System.Collections.Generic;
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
        public SimpleApplication app1;
        public SimpleApplication app2;
        public SimpleApplication server;

        private Guid sharedGuid;

        public MainPage() {
            this.InitializeComponent();
            sharedGuid = Guid.NewGuid();
            app1 = new SimpleApplication();
            app2 = new SimpleApplication();
            server = new SimpleApplication();
        }

        private void App1_AddClick(object sender, RoutedEventArgs e) {
            var agg = new SimpleTextAggregate("foo");
            app1.Models.Add(agg);
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
            var events = app1.GetAllEvents().Select(ev => InMemoryJsonEventRepository.Serialize(ev));
            EventsTextBlock.Text = string.Join(Environment.NewLine, events);
        }

        private void DataGrid1_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            app1.Commit();
        }

        private void App2_AddClick(object sender, RoutedEventArgs e) {
            var agg = new SimpleTextAggregate("bar");
            app2.Models.Add(agg);
            app2.Commit();
        }

        private void App2_PullClick(object sender, RoutedEventArgs e) {
            app2.ReceiveEvents(server.GetAllEvents());
        }

        private void App2_PushClick(object sender, RoutedEventArgs e) {
            server.ReceiveEvents(app2.GetAllEvents());
        }

        private void App2_ViewEventsClick(object sender, RoutedEventArgs e) {
            var events = app2.GetAllEvents().Select(ev => InMemoryJsonEventRepository.Serialize(ev));
            EventsTextBlock.Text = string.Join(Environment.NewLine, events);
        }

        private void DataGrid2_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            app2.Commit();
        }

        private void DataGridServer_CellEditEnded(object sender, Microsoft.Toolkit.Uwp.UI.Controls.DataGridCellEditEndedEventArgs e) {
            server.Commit();
        }

        private void Server_ViewEventsClick(object sender, RoutedEventArgs e) {
            var events = server.GetAllEvents().Select(ev => InMemoryJsonEventRepository.Serialize(ev));
            EventsTextBlock.Text = string.Join(Environment.NewLine, events);
        }
    }
}