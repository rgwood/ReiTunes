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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        const searchInput = document.getElementById('search-input') as HTMLInputElement
        searchInput?.focus()
      } else if (e.ctrlKey && e.key === 'e') {
        e.preventDefault()
        playRandomBookmark()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [items])

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
    if (!selectedItem || !audioRef.current) {
      alert("Please select a song first.")
      return
    }
    
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

  const formatBookmarks = (item: LibraryItem, bookmarks: Record<string, { position: number; emoji?: string }>) => {
    return Object.values(bookmarks).map((bookmark, index) => {
      const minutes = Math.floor(bookmark.position / 60)
      const seconds = Math.floor(bookmark.position % 60)
      const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`
      
      return (
        <span
          key={index}
          className="cursor-pointer hover:underline decoration-solarized-blue decoration-2 rounded mr-1"
          title={timeString}
          onClick={(e) => {
            e.stopPropagation()
            playSong(item, bookmark.position)
          }}
        >
          {bookmark.emoji || '🔖'}
        </span>
      )
    })
  }

  return (
    <div className="bg-solarized-base03 text-solarized-base2 min-h-screen font-consolas overflow-x-hidden overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-solarized-base03 pt-5 px-5 pb-3 z-10">
        <div className="flex justify-between items-center mb-3">
          <div className="text-2xl flex-grow">
            <span id="current-song" className="text-solarized-blue text-shadow-solarized">
              {currentSong}
            </span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="relative w-48">
              <input
                type="text"
                id="search-input"
                placeholder="Search...."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-2 py-1 bg-solarized-base03 text-solarized-base1 border border-solarized-blue text-lg placeholder-solarized-base00"
                autoComplete="off"
              />
            </div>
            <button
              onClick={addBookmark}
              className="px-3 py-1 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors duration-300"
            >
              🔖
            </button>
            <button
              onClick={playRandomBookmark}
              className="px-3 py-1 bg-solarized-blue text-solarized-base03 rounded hover:bg-solarized-cyan transition-colors duration-300"
            >
              🎲
            </button>
          </div>
        </div>
        
        <div className="flex items-center space-x-2 mb-3">
          <button
            onClick={() => audioRef.current && (audioRef.current.currentTime -= 30)}
            className="px-3 py-2 bg-solarized-base03 text-solarized-base2 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30"
          >
            ⏪
          </button>
          <button
            onClick={() => audioRef.current && (audioRef.current.currentTime += 30)}
            className="px-3 py-2 bg-solarized-base03 text-solarized-base3 border border-solarized-blue rounded-sm hover:bg-solarized-blue hover:bg-opacity-30"
          >
            ⏩
          </button>
          <audio
            ref={audioRef}
            controls
            autoPlay
            className="flex-grow bg-solarized-base02 border border-solarized-blue"
          >
            Your browser does not support the audio element.
          </audio>
        </div>
      </div>

      {/* Table */}
      <div className="px-5">
        <div className="border border-solarized-base01" style={{height: 'calc(100vh - 150px)'}}>
          <div className="overflow-auto h-full">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-solarized-base02 border-b border-solarized-base00">
                <tr className="text-solarized-base2 font-bold">
                  <th className="text-left p-1 border-r border-solarized-base01 w-3/10">Name</th>
                  <th className="text-left p-1 border-r border-solarized-base01 w-2/10">Artist</th>
                  <th className="text-left p-1 border-r border-solarized-base01 w-1/10">Album</th>
                  <th className="text-left p-1 border-r border-solarized-base01">Play Count</th>
                  <th className="text-left p-1 border-r border-solarized-base01 w-1.5/10">Bookmarks</th>
                  <th className="text-left p-1">Created At (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, index) => (
                  <tr
                    key={item.id}
                    className={`
                      border-b border-solarized-base01 cursor-pointer transition-colors duration-200
                      ${index % 2 === 0 ? 'bg-solarized-base02' : 'bg-solarized-base03'}
                      ${selectedItem?.id === item.id ? 'bg-solarized-blue' : ''}
                      hover:bg-solarized-base01
                    `}
                    onClick={() => playSong(item)}
                  >
                    <td className="p-1 border-r border-solarized-base01 whitespace-nowrap overflow-hidden text-ellipsis">
                      {item.name}
                    </td>
                    <td className="p-1 border-r border-solarized-base01 whitespace-nowrap overflow-hidden text-ellipsis">
                      {item.artist}
                    </td>
                    <td className="p-1 border-r border-solarized-base01 whitespace-nowrap overflow-hidden text-ellipsis">
                      {item.album}
                    </td>
                    <td className="p-1 border-r border-solarized-base01">
                      {item.play_count}
                    </td>
                    <td className="p-1 border-r border-solarized-base01">
                      {formatBookmarks(item, item.bookmarks)}
                    </td>
                    <td className="p-1">
                      {item.created_time_utc.split('.')[0]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App