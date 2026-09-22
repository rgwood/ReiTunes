import { useEffect, useId, useRef } from 'react';
import { libraryColumns, useLibraryPreferences } from '../stores/libraryPreferences';
import './SettingsDialog.css';

export function ColumnsDialog({ onClose }: { onClose: () => void }) {
  const { columnOrder, columnVisibility, setColumnVisible, moveColumn, resetColumns } = useLibraryPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return <dialog ref={dialog} className="settings-dialog columns-dialog" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="settings-content">
      <header className="settings-header"><h2 id={id}>Choose columns</h2></header>
      <p className="columns-help">Applies to all library views on this device. Drag headers to reorder; drag their edges to resize.</p>
      <ol className="columns-list">
        {columnOrder.map((columnId, index) => {
          const column = libraryColumns.find(column => column.id === columnId)!;
          return <li key={columnId}>
            <label><input type="checkbox" checked={columnVisibility[columnId] !== false} disabled={columnId === 'name'}
              onChange={event => setColumnVisible(columnId, event.target.checked)} />
              {column.label}{columnId === 'name' && <small>Always shown</small>}</label>
            <button type="button" aria-label={`Move ${column.label} left`} disabled={index === 0}
              onClick={() => moveColumn(columnId, columnOrder[index - 1])}>←</button>
            <button type="button" aria-label={`Move ${column.label} right`} disabled={index === columnOrder.length - 1}
              onClick={() => moveColumn(columnId, columnOrder[index + 1])}>→</button>
          </li>;
        })}
      </ol>
      <footer><button type="button" className="columns-reset" onClick={resetColumns}>Restore defaults</button>
        <button type="button" onClick={close}>Done</button></footer>
    </div>
  </dialog>;
}
