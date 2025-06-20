import { useState, useEffect, useRef } from 'react'

interface LibraryItem {
  id: number
  name: string
  artist: string
  album: string
  play_count: number
  bookmarks: Record<string, { position: number; emoji?: string }>
  created_time_utc: string
  file_path: string
}

function App() {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [currentSong, setCurrentSong] = useState<string>("No song selected")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [selectedItem, setSelectedItem] = useState<LibraryItem | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  // Load initial data
  useEffect(() => {
    fetch('/api/library')
      .then(res => res.json())
      .then(data => setItems(data))
      .catch(err => console.error('Failed to load library:', err))
  }, [])

  // WebSocket connection for real-time updates
  useEffect(() => {
    const url = new URL("/updates", window.location.href)
    url.protocol = url.protocol.replace("http", "ws")
    
    const socket = new WebSocket(url.href)
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'update') {
        setItems(prev => {
          const index = prev.findIndex(item => item.id === message.item.id)
          if (index >= 0) {
            const updated = [...prev]
            updated[index] = message.item
            return updated
          }
          return [...prev, message.item]
        })
      } else if (message.type === 'delete') {
        setItems(prev => prev.filter(item => item.id !== message.id))
      }
    }

    return () => socket.close()
  }, [])

  const filteredItems = items.filter(item =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.artist.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.album.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const playSong = (item: LibraryItem, startPosition = 0, incrementPlayCount = true) => {
    if (!audioRef.current) return
    
    const url = `https://reitunes.blob.core.windows.net/music/${item.file_path}`
    audioRef.current.src = url
    audioRef.current.currentTime = startPosition
    audioRef.current.play()
    
    setCurrentSong(`${item.name} - ${item.artist}`)
    setSelectedItem(item)

    if (incrementPlayCount) {
      fetch('/ui/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      }).catch(err => console.error('Failed to update play count:', err))
    }
  }

  const addBookmark = () => {
    if (!selectedItem || !audioRef.current) return
    
    const currentTime = audioRef.current.currentTime
    fetch(`/ui/${selectedItem.id}/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: currentTime }),
    }).catch(err => console.error('Failed to add bookmark:', err))
  }

  const playRandomBookmark = () => {
    const allBookmarks: Array<{ item: LibraryItem; position: number }> = []
    items.forEach(item => {
      Object.values(item.bookmarks).forEach(bookmark => {
        allBookmarks.push({ item, position: bookmark.position })
      })
    })
    
    if (allBookmarks.length === 0) {
      alert("No bookmarks found in the library.")
      return
    }
    
    const randomBookmark = allBookmarks[Math.floor(Math.random() * allBookmarks.length)]
    playSong(randomBookmark.item, randomBookmark.position, false)
  }

  const formatBookmarks = (bookmarks: Record<string, { position: number; emoji?: string }>) => {
    return Object.values(bookmarks).map((bookmark, index) => {
      const minutes = Math.floor(bookmark.position / 60)
      const seconds = Math.floor(bookmark.position % 60)
      const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`
      
      return (
        <span
          key={index}
          className="cursor-pointer hover:underline decoration-blue-400 decoration-2 rounded mr-1"
          title={timeString}
          onClick={() => selectedItem && playSong(selectedItem, bookmark.position)}
        >
          {bookmark.emoji || '🔖'}
        </span>
      )
    })
  }

  return (
    <div className="bg-slate-900 text-slate-300 min-h-screen font-mono">
      {/* Header */}
      <div className="sticky top-0 bg-slate-900 pt-5 px-5 pb-3 z-10">
        <div className="flex justify-between items-center mb-3">
          <div className="text-2xl flex-grow">
            <span className="text-blue-400">{currentSong}</span>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-48 px-2 py-1 bg-slate-900 text-slate-300 border border-blue-400 text-lg placeholder-slate-500"
            />
            <button
              onClick={addBookmark}
              className="px-3 py-1 bg-blue-600 text-slate-900 rounded hover:bg-cyan-500 transition-colors duration-300"
            >
              🔖
            </button>
            <button
              onClick={playRandomBookmark}
              className="px-3 py-1 bg-blue-600 text-slate-900 rounded hover:bg-cyan-500 transition-colors duration-300"
            >
              🎲
            </button>
          </div>
        </div>
        
        <div className="flex items-center space-x-2 mb-3">
          <button
            onClick={() => audioRef.current && (audioRef.current.currentTime -= 30)}
            className="px-3 py-2 bg-slate-900 text-slate-200 border border-blue-400 rounded-sm hover:bg-blue-600 hover:bg-opacity-30"
          >
            ⏪
          </button>
          <button
            onClick={() => audioRef.current && (audioRef.current.currentTime += 30)}
            className="px-3 py-2 bg-slate-900 text-slate-200 border border-blue-400 rounded-sm hover:bg-blue-600 hover:bg-opacity-30"
          >
            ⏩
          </button>
          <audio
            ref={audioRef}
            controls
            autoPlay
            className="flex-grow bg-slate-800 border border-blue-400"
          >
            Your browser does not support the audio element.
          </audio>
        </div>
      </div>

      {/* Table */}
      <div className="px-5">
        <div className="overflow-auto" style={{height: 'calc(100vh - 150px)'}}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-800">
              <tr>
                <th className="text-left p-2 w-3/10">Name</th>
                <th className="text-left p-2 w-2/10">Artist</th>
                <th className="text-left p-2 w-1/10">Album</th>
                <th className="text-left p-2">Play Count</th>
                <th className="text-left p-2 w-1.5/10">Bookmarks</th>
                <th className="text-left p-2">Created At (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr
                  key={item.id}
                  className={`border-b border-slate-700 hover:bg-slate-800 cursor-pointer ${
                    selectedItem?.id === item.id ? 'bg-blue-900 bg-opacity-30' : ''
                  }`}
                  onClick={() => playSong(item)}
                >
                  <td className="p-2">{item.name}</td>
                  <td className="p-2">{item.artist}</td>
                  <td className="p-2">{item.album}</td>
                  <td className="p-2">{item.play_count}</td>
                  <td className="p-2">{formatBookmarks(item.bookmarks)}</td>
                  <td className="p-2">{item.created_time_utc.split('.')[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default App