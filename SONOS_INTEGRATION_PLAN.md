# Sonos Integration Plan for ReiTunes

## Overview

This document outlines the implementation plan for making ReiTunes a Sonos music provider using the Sonos Music API (SMAPI). This will allow users to browse and play ReiTunes music directly through the Sonos app and speakers.

## Current ReiTunes Architecture

### Existing Components
- **Rust web server** (`reitunes/src/main.rs`) serving HTTP API and React frontend
- **Event-sourced architecture** with SQLite database storing music library events
- **Library management** with tracks, artists, albums, play counts, and bookmarks
- **Audio file storage** served from Azure Blob Storage (`https://reitunes.blob.core.windows.net/music/`)
- **Authentication** via session cookies and API keys
- **WebSocket updates** for real-time library changes

### Key Data Structures
- `LibraryItem` - Core music track representation
- `Library` - In-memory collection of all items
- `Event` - Event sourcing for state changes
- `Bookmark` - Playback position markers

## Sonos Integration Requirements

### Sonos Music API (SMAPI)
- **Protocol**: SOAP 1.1 over HTTP/HTTPS
- **Authentication**: OAuth 2.0 (recommended) or device authentication
- **Security**: TLS 1.2+ required for production
- **Format**: XML-based request/response using WSDL definitions

### Required SMAPI Endpoints
1. **Authentication**
   - `getSessionId` - Initial authentication
   - `getDeviceLinkCode` - Device linking flow
   
2. **Browse/Search**
   - `getMetadata` - Browse library structure
   - `search` - Search across content
   - `getExtendedMetadata` - Detailed item information
   
3. **Playback**
   - `getMediaURI` - Return audio stream URLs
   - `getMediaMetadata` - Track metadata for playback
   
4. **Sync**
   - `getLastUpdate` - Library versioning for sync

## Implementation Plan

### Phase 1: SOAP Service Foundation

#### 1.1 Add Dependencies
Add to `reitunes/Cargo.toml`:
```toml
# SOAP handling
quick-xml = "0.31"
serde-xml-rs = "0.6"
soap = "0.3"  # or custom SOAP implementation

# Enhanced HTTP handling
tower-http = { version = "0.6.2", features = ["fs", "cors", "trace"] }
```

#### 1.2 Create SMAPI Module Structure
```
src/smapi/
├── mod.rs              # Main SMAPI module
├── soap.rs             # SOAP request/response handling
├── auth.rs             # Authentication handlers
├── metadata.rs         # Metadata conversion
├── endpoints.rs        # SMAPI endpoint implementations
└── types.rs            # SMAPI data structures
```

#### 1.3 SOAP Service Integration
- Add SOAP middleware to existing Axum router
- Handle XML parsing and response generation
- Implement error handling for SOAP faults

### Phase 2: Core SMAPI Endpoints

#### 2.1 Metadata Browsing Structure
```
Root
├── Artists
│   └── [Artist Name]
│       └── Albums
│           └── [Album Name]
│               └── Tracks
├── Albums
│   └── [Album Name]
│       └── Tracks
├── Recent Tracks
├── Most Played
└── Bookmarks
    └── [Track Name] - [Bookmark Position]
```

#### 2.2 Search Implementation
- Full-text search across track names, artists, albums
- Fuzzy matching using existing `FuzzyMatch` utility
- Result ranking by play count and relevance

#### 2.3 Audio Streaming
- Direct URLs to Azure Blob Storage (which supports range requests for seeking)
- Audio format detection based on file extension

### Phase 3: Sandbox Testing Setup

#### 3.1 Sonos Developer Portal
- Sign up for free Sonos Developer Portal account
- Create test service entry with ReiTunes details
- Set endpoint to `http://your-local-ip:5000/smapi/v1/soap`
- Add your Sonos device IDs to sandbox

#### 3.2 Anonymous Access (No Authentication)
- Skip OAuth complexity entirely
- Use existing API key authentication if desired
- Service works without user login on registered devices

### Phase 4: LibraryItem Enhancements

#### 4.1 Current LibraryItem Structure
```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LibraryItem {
    pub id: Uuid,
    pub name: String,
    pub created_time_utc: DateTime,
    pub file_path: String,
    pub artist: String,
    pub album: String,
    pub play_count: u32,
    pub bookmarks: IndexMap<Uuid, Bookmark>,
}
```

#### 4.2 Minimal SMAPI Extensions
```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LibraryItem {
    // Existing fields (unchanged)
    pub id: Uuid,                             // Can reuse as SMAPI ID
    pub name: String,
    pub created_time_utc: DateTime,
    pub file_path: String,
    pub artist: String,
    pub album: String,
    pub play_count: u32,
    pub bookmarks: IndexMap<Uuid, Bookmark>,
    
    // Minimal SMAPI additions
    pub duration: Option<Duration>,           // Track length (useful for UI)
    pub track_number: Option<u32>,            // Track number in album (useful for sorting)
}
```

**Notes:**
- `content_type` can be inferred from file extension (`.mp3` → `audio/mpeg`)
- `id` field can be reused as SMAPI identifier (convert to string as needed)
- All other metadata is optional and can be added later if needed

#### 4.3 Minimal Event Types
```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type", rename_all_fields = "PascalCase")]
pub enum Event {
    // Existing events...
    
    // Minimal SMAPI-related events
    LibraryItemDurationChangedEvent {
        new_duration: Option<Duration>,
    },
    LibraryItemTrackNumberChangedEvent {
        new_track_number: Option<u32>,
    },
}
```

#### 4.4 Minimal Metadata Enrichment
1. **Audio File Analysis (Optional)**
   - Use `symphonia` crate to extract duration and track number from ID3 tags
   - Only extract these two fields to keep complexity low

2. **Manual Entry**
   - Allow users to manually set duration and track number via web interface
   - Simple form additions to existing UI

### Phase 5: Database Schema Updates (Optional)

#### 5.1 No Authentication Tables Needed
- Anonymous access means no OAuth tables required
- Can use existing authentication if desired

### Phase 6: API Route Extensions

#### 6.1 Simplified SMAPI Routes
```rust
let smapi_router = Router::new()
    .route("/smapi/v1/soap", post(smapi_soap_handler))
    // No auth routes needed for anonymous access!
    .layer(middleware::from_fn_with_state(app_state.clone(), optional_api_key_auth));
```

#### 6.2 Minimal Library API Extensions
```rust
let api_router = Router::new()
    .route("/library/search", get(search_handler))       // For SMAPI search
    .route("/library/browse/{category}", get(browse_handler))  // For SMAPI browse
    .route_layer(middleware::from_fn(api_key_auth));
```

### Phase 7: Testing & Deployment

#### 7.1 Development Testing
- Unit tests for SMAPI response formatting
- SoapUI testing for endpoint validation
- Test with your own Sonos devices via sandbox

#### 7.2 Sandbox Deployment
- Set up Sonos Developer Portal test service
- Add your home Sonos device IDs to sandbox
- Configure service endpoint URL
- Test browsing and playback through Sonos app

#### 7.3 Local Network Deployment
- Deploy ReiTunes on local network (HTTP is fine)
- Ensure Sonos devices can reach your server
- No external certificates or domain needed

## Migration Strategy

### Backward Compatibility
- All existing ReiTunes functionality remains unchanged
- New SMAPI fields are optional and don't break existing data
- Gradual metadata enrichment without service disruption

### Rollout Plan
1. **Phase 1**: Core SOAP infrastructure (no user impact)
2. **Phase 2**: Minimal metadata additions (duration, track number)
3. **Phase 3**: Sandbox testing with your Sonos devices
4. **Phase 4**: Local network deployment for home use

## Success Metrics
- ReiTunes service appears in Sonos app on sandbox devices
- Can browse complete library structure (Artists → Albums → Tracks)
- Audio streaming works reliably to your Sonos speakers
- Search functionality works adequately
- Performance is acceptable for home use

## Risks & Mitigation
- **SOAP Complexity**: Start with minimal implementation, add features incrementally
- **Audio Compatibility**: Test with your existing music files, add transcoding if needed
- **Performance**: Optimize database queries, cache metadata if necessary
- **Network Issues**: Ensure ReiTunes server is accessible from Sonos devices on local network
- **Sandbox Limitations**: Service only works on registered devices (perfect for home use)