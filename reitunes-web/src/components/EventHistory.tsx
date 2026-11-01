import { Fragment, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import './EventHistory.css';

interface FieldChange { field: string; before: unknown; after: unknown }

interface HistoryEvent {
  id: string;
  aggregate_id: string;
  aggregate_type: 'LibraryItem' | 'Playlist';
  aggregate_name: string | null;
  created_time_utc: string;
  machine_name: string;
  event_type: string;
  payload: unknown;
  changes: FieldChange[];
}

interface EventHistoryPage {
  total: number;
  matching: number;
  type_counts: Record<string, number>;
  replay: { elapsed_ms: number; matches_live: boolean; drifted: string[] };
  events: HistoryEvent[];
  next_before: string | null;
}

const typeLabel = (type: string) => type.replace(/^(LibraryItem|Playlist)/, '').replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const fieldLabel = (field: string) => field.replace(uuid, id => id.slice(0, 8));

function valueLabel(value: unknown) {
  if (value === null || value === undefined) return '∅';
  if (value === '') return '(empty)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function timeLabel(time: string) {
  return new Date(/Z|[+-]\d\d:\d\d$/.test(time) ? time : time + 'Z').toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}

export function EventHistory({ searchQuery }: { searchQuery: string }) {
  const [eventType, setEventType] = useState('');
  const [aggregate, setAggregate] = useState<{ id: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const history = useInfiniteQuery<EventHistoryPage>({
    queryKey: ['event-history', eventType, aggregate?.id, searchQuery],
    initialPageParam: null,
    getNextPageParam: last => last.next_before,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('before', pageParam as string);
      if (eventType) params.set('event_type', eventType);
      if (aggregate) params.set('aggregate', aggregate.id);
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      const response = await fetch(`/api/events?${params}`, { signal });
      if (!response.ok) throw new Error('Could not load the event log');
      return response.json();
    },
    // The log only changes when something else does, but this view exists to watch it.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const first = history.data?.pages[0];
  const events = history.data?.pages.flatMap(page => page.events) ?? [];
  // New events can shift page boundaries between fetches, so pages may overlap.
  const unique = [...new Map(events.map(event => [event.id, event])).values()];

  return <div className="event-history">
    <div className="event-toolbar">
      <select aria-label="Event type" value={eventType} onChange={event => setEventType(event.target.value)}>
        <option value="">All events{first ? ` (${first.total.toLocaleString()})` : ''}</option>
        {Object.entries(first?.type_counts ?? {}).sort((a, b) => b[1] - a[1]).map(([type, count]) =>
          <option key={type} value={type}>{type.startsWith('Playlist') ? 'Playlist: ' : ''}{typeLabel(type)} ({count.toLocaleString()})</option>)}
      </select>
      {aggregate && <button className="event-focus" onClick={() => setAggregate(null)} title="Show every item again">{aggregate.name} ✕</button>}
      <button onClick={() => void history.refetch()} disabled={history.isFetching}>Refresh</button>
      <span className="event-summary" role="status">
        {first && <>{first.matching.toLocaleString()} {first.matching === 1 ? 'event' : 'events'} · replayed in {Math.round(first.replay.elapsed_ms)} ms · </>}
        {first && (first.replay.matches_live
          ? <span className="event-replay-ok" title="Rebuilding everything from the log gives exactly the state the server has in memory">matches live state</span>
          : <span className="event-replay-bad" title={first.replay.drifted.join('\n')}>differs from live state ({first.replay.drifted.length})</span>)}
      </span>
    </div>
    {history.isError ? <div className="library-message" role="alert">Couldn’t load the event log. <button onClick={() => void history.refetch()}>Retry</button></div>
      : history.isPending ? <div className="library-message" role="status">Loading…</div>
      : !unique.length ? <div className="library-message">No matching events.</div>
      : <div className="event-scroll"><table className="event-table">
        <thead><tr><th>Time</th><th>Event</th><th>Item</th><th>What changed</th><th>Machine</th></tr></thead>
        <tbody>
          {unique.map(event => <Fragment key={event.id}>
            <tr aria-expanded={expanded === event.id} onClick={() => setExpanded(expanded === event.id ? null : event.id)}>
              <td className="event-time">{timeLabel(event.created_time_utc)}</td>
              <td className="event-type">{event.aggregate_type === 'Playlist' && <span className="event-kind">Playlist</span>}{typeLabel(event.event_type)}</td>
              <td className="event-name"><button title="Show only this item's history" onClick={click => {
                click.stopPropagation();
                setAggregate({ id: event.aggregate_id, name: event.aggregate_name ?? event.aggregate_id.slice(0, 8) });
              }}>{event.aggregate_name ?? event.aggregate_id.slice(0, 8)}</button></td>
              <td className="event-changes">
                {event.changes.length === 0 ? <span className="event-noop">no change</span>
                  : event.changes.map(change => <div key={change.field}>
                    <span className="event-field">{fieldLabel(change.field)}</span>{' '}
                    <span className="event-old">{valueLabel(change.before)}</span>{' → '}
                    <span className="event-new">{valueLabel(change.after)}</span>
                  </div>)}
              </td>
              <td className="event-machine">{event.machine_name}</td>
            </tr>
            {expanded === event.id && <tr className="event-detail"><td colSpan={5}>
              <pre>{JSON.stringify({ id: event.id, aggregate_id: event.aggregate_id, created_time_utc: event.created_time_utc, payload: event.payload }, null, 2)}</pre>
            </td></tr>}
          </Fragment>)}
        </tbody>
      </table>
        {history.hasNextPage && <button className="event-more" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          {history.isFetchingNextPage ? 'Loading…' : 'Load older events'}
        </button>}
      </div>}
  </div>;
}
