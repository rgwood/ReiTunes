// Share one observer across the grid. Row shells retain their normal height,
// order, and focus targets while expensive cells only mount near the viewport.
export function createLibraryRowVisibility() {
  const rows = new Map<Element, { visible: boolean; onChange: (visible: boolean) => void }>();
  let observer: IntersectionObserver | null = null;
  return {
    observe(row: Element, onChange: (visible: boolean) => void) {
      observer ??= new IntersectionObserver(entries => {
        for (const entry of entries) {
          const row = rows.get(entry.target);
          if (!row) continue;
          row.visible = entry.isIntersecting;
          row.onChange(entry.isIntersecting || entry.target.contains(document.activeElement));
        }
      }, { root: row.closest('[data-library-scroll]'), rootMargin: '600px 0px' });
      rows.set(row, { visible: false, onChange });
      observer.observe(row);
      return () => {
        rows.delete(row);
        observer?.unobserve(row);
        if (!rows.size) {
          observer?.disconnect();
          observer = null;
        }
      };
    },
    releaseFocus(row: Element) {
      const state = rows.get(row);
      if (state) state.onChange(state.visible);
    },
  };
}

export type LibraryRowVisibility = ReturnType<typeof createLibraryRowVisibility>;
