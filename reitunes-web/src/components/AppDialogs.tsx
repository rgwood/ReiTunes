import { useEffect, useRef } from 'react';
import { resolveDialog, useDialogStore } from '../stores/dialogStore';
import './AppDialogs.css';

export function AppDialogs() {
  const request = useDialogStore(state => state.requests[0]);
  return request ? <AppDialog key={request.id} request={request} /> : null;
}

function AppDialog({ request }: { request: ReturnType<typeof useDialogStore.getState>['requests'][number] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    (request.confirmation ? cancel : action).current?.focus();
    return () => element.close();
  }, [request]);
  const finish = (accepted: boolean) => {
    // Close before resolving so focus returns to the underlying dialog first.
    dialog.current?.close();
    resolveDialog(request.id, accepted);
  };
  return <dialog ref={dialog} className="app-dialog" aria-labelledby={`app-dialog-title-${request.id}`}
    aria-describedby={`app-dialog-message-${request.id}`} onCancel={event => { event.preventDefault(); finish(false); }}>
    <h2 id={`app-dialog-title-${request.id}`}>{request.title}</h2>
    <p id={`app-dialog-message-${request.id}`}>{request.message}</p>
    {request.details && <ul className="app-dialog-details" aria-label="Selected songs">
      {request.details.map((detail, index) => <li key={index}>{detail}</li>)}
    </ul>}
    <footer>
      {request.confirmation && <button ref={cancel} type="button" onClick={() => finish(false)}>Cancel</button>}
      <button ref={action} type="button" className={request.destructive ? 'destructive' : 'primary'} onClick={() => finish(true)}>{request.actionLabel}</button>
    </footer>
  </dialog>;
}
