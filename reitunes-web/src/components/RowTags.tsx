import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { effectiveTags, tagProgress, type ItemTags } from '../hooks/useTags';

export function RowTags({ name, data, selected, onEdit, onFilter }: {
  name: string; data?: ItemTags; selected: boolean;
  onEdit: () => void; onFilter: (tag: string) => void;
}) {
  const tags = useMemo(() => effectiveTags(data), [data]);
  const linksRef = useRef<HTMLSpanElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);

  useLayoutEffect(() => {
    const links = linksRef.current!;
    const buttons = [...links.querySelectorAll<HTMLButtonElement>('.row-tag-link')];
    const measure = () => {
      const edge = links.getBoundingClientRect().right;
      const firstHidden = buttons.findIndex(button => button.getBoundingClientRect().right > edge + 0.5);
      const count = firstHidden < 0 ? buttons.length : firstHidden;
      // A resized column must not leave keyboard focus on a hidden tag.
      if (buttons.slice(count).some(button => button === document.activeElement)) editRef.current?.focus({ preventScroll: true });
      setVisibleCount(count);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(links);
    // Font changes can change chip widths without changing the column width.
    buttons.forEach(button => observer.observe(button));
    measure();
    return () => observer.disconnect();
  }, [tags]);

  const hiddenCount = Math.max(0, tags.length - visibleCount);
  return <div className="row-tags">
    <span ref={linksRef} className="row-tag-links">{tags.map((tag, index) => <button key={tag} className="row-tag-link"
      style={{ visibility: index < visibleCount ? undefined : 'hidden' }}
      aria-hidden={index >= visibleCount || undefined} tabIndex={index < visibleCount ? 0 : -1}
      title={`Browse all music tagged ${tag}`} aria-label={`Browse music tagged ${tag}`}
      onClick={event => { event.stopPropagation(); onFilter(tag); }}>{tag}</button>)}
      {!tags.length && <span className="row-tags-empty" title={tagProgress(data)}>
        {data?.status === 'running' ? 'Generating…' : data?.status === 'queued' ? 'Waiting…' : data?.status === 'failed' ? 'Failed' : '—'}
      </span>}
    </span>
    <button ref={editRef} type="button" className={`row-tag-edit${hiddenCount ? ' has-more' : ''}`}
      // Keep the space reserved for the count stable as tags fit or overflow.
      style={{ width: `calc(${Math.max(2, String(tags.length).length + 1)}ch + 6px)` }}
      aria-label={`Edit tags for ${name}`} aria-pressed={selected}
      title={hiddenCount ? `${hiddenCount} more: ${tags.slice(visibleCount).join(', ')} — manage tags` : 'Add or remove tags'}
      onClick={event => { event.stopPropagation(); onEdit(); }}>{hiddenCount ? `+${hiddenCount}` : '…'}</button>
  </div>;
}
