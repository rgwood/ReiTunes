using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ByteDev.Sonos;
using ByteDev.Sonos.Models;
using ByteDev.Sonos.Upnp.Services;

namespace ReiTunes.Core {

    public class SonosIntermediary {
        private readonly string _ipAddress;

        //TODO encapsulate this
        public readonly SonosController _sonosController;

        public SonosIntermediary(string ipAddress) {
            _ipAddress = ipAddress;
            _sonosController = new SonosController(new AvTransportService(ipAddress),
                new RenderingControlService(ipAddress),
                new ContentDirectoryService(ipAddress));
        }

        public async Task Play(string trackUri) {
            // This sequence of operations worked in a Framework console app, but it doesn't seem to be working in UWP 🤔
            await _sonosController.StopAsync();
            await _sonosController.ClearQueueAsync();
            await _sonosController.AddQueueTrackAsync(trackUri, 0, true);
            await _sonosController.PlayAsync();
        }
    }
}