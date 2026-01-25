import { useCallback } from 'react';
import { toggleFavorite } from '../hooks/useLibrary';

interface FavoriteButtonProps {
  itemId: string;
  isFavorite: boolean;
}

export function FavoriteButton({ itemId, isFavorite }: FavoriteButtonProps) {
  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await toggleFavorite(itemId, isFavorite);
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
      alert('Failed to toggle favorite');
    }
  }, [itemId, isFavorite]);

  return (
    <button
      onClick={handleClick}
      className={`text-lg transition-colors duration-200 ${
        isFavorite
          ? 'text-solarized-red hover:text-solarized-orange'
          : 'text-solarized-base01 hover:text-solarized-red'
      }`}
      title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
    >
      {isFavorite ? '\u2665' : '\u2661'}
    </button>
  );
}
