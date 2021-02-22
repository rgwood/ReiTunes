using System.Collections.Generic;
using Windows.UI.Xaml.Controls;

// The Content Dialog item template is documented at https://go.microsoft.com/fwlink/?LinkId=234238

namespace ReiTunes.Views {

    public sealed partial class RecentEventsContentDialog : ContentDialog {

        public RecentEventsContentDialog(IEnumerable<string> events) {
            this.InitializeComponent();
            foreach (string @event in events) {
                EventsListView.Items.Add(@event);
            }
        }

        private void ContentDialog_PrimaryButtonClick(ContentDialog sender, ContentDialogButtonClickEventArgs args) {
        }

        private void ContentDialog_SecondaryButtonClick(ContentDialog sender, ContentDialogButtonClickEventArgs args) {
        }
    }
}