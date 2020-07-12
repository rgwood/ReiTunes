using Newtonsoft.Json.Serialization;
using System;
using System.Collections.Generic;
using System.Linq;

namespace ReiTunes.Core {

    /// <summary>
    /// This helps JSON.NET serialize+deserialize IEvents based solely on the unqualified type names.
    /// Without this, JSON.NET's type name serialization is fully qualified with an assembly name!
    /// ex: "$type": "ReiTunes.Core.SimpleTextAggregateCreatedEvent, ReiTunes.Records"
    /// This is bad for my needs, I want the flexibility to change up my event implementation later on.
    /// Hence, this serializationbinder which is purely based on unqualified names.
    /// Got the idea from http://appetere.com/post/serializing-interfaces-with-jsonnet
    /// </summary>
    public class EventBinder : ISerializationBinder {

        private IList<Type> _knownTypes = new List<Type> {
            typeof(SimpleTextAggregateCreatedEvent),
            typeof(SimpleTextAggregateUpdatedEvent),
            typeof(LibraryItemCreatedEvent),
            typeof(LibraryItemPlayedEvent),
            typeof(LibraryItemNameChangedEvent),
            typeof(LibraryItemFilePathChangedEvent),
            typeof(LibraryItemAlbumChangedEvent),
            typeof(LibraryItemArtistChangedEvent)
        };

        public Type BindToType(string assemblyName, string typeName) {
            return _knownTypes.SingleOrDefault(t => t.Name == typeName);
        }

        public void BindToName(Type serializedType, out string assemblyName, out string typeName) {
            assemblyName = null;
            typeName = serializedType.Name;
        }
    }
}