import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type GridDensity = 'compact' | 'comfortable';

export const useLibraryPreferences = create<{
  density: GridDensity;
  showDetails: boolean;
  setShowDetails: (showDetails: boolean) => void;
  setDensity: (density: GridDensity) => void;
}>()(persist(set => ({
  density: 'compact',
  showDetails: false,
  setShowDetails: showDetails => set({ showDetails }),
  setDensity: density => set({ density }),
}), {
  name: 'reitunes-library-preferences',
  partialize: state => ({ density: state.density, showDetails: state.showDetails }),
}));
