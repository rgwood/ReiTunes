import { useEffect, useId, useRef, useState } from 'react';
import {
  autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift,
  useClick, useDismiss, useFloating, useInteractions, useRole,
} from '@floating-ui/react';
import { useSonosVolume } from '../hooks/useSonosVolume';
import type { SonosSpeaker } from '../stores/playbackTargetStore';
import { MusicIcon } from './MusicIcon';
import './SonosSpeakerVolumes.css';

interface ListProps {
  speakers: SonosSpeaker[];
  disabled: boolean;
  // Changes whenever the group's volume does, since that rescales every speaker.
  groupVolumeKey: string;
  onSpeakerChanged: () => void;
  // Phones use the sheet's native touch-sized sliders.
  touch?: boolean;
}

export function SonosSpeakerVolumeList({ speakers, ...props }: ListProps) {
  return <div className="speaker-volume-list">
    {speakers.map(speaker => <SpeakerVolumeRow key={speaker.id} speaker={speaker} {...props} />)}
  </div>;
}

function SpeakerVolumeRow({ speaker, disabled, groupVolumeKey, onSpeakerChanged, touch }: Omit<ListProps, 'speakers'> & { speaker: SonosSpeaker }) {
  const { volume, requestedVolume, isPending, commandError, pollError, refresh, setVolume, setMuted } =
    useSonosVolume(speaker.id, 'player');
  const [draft, setDraft] = useState<number | null>(null);
  const seenGroupVolume = useRef(groupVolumeKey);
  useEffect(() => {
    if (seenGroupVolume.current === groupVolumeKey) return;
    seenGroupVolume.current = groupVolumeKey;
    void refresh().catch(() => undefined);
  }, [groupVolumeKey, refresh]);

  const displayed = draft ?? requestedVolume ?? volume?.volume ?? 0;
  const sliderDisabled = disabled || !volume || volume.fixed || (isPending && requestedVolume === null);
  const commit = (value: number) => {
    setDraft(null);
    void setVolume(value).then(onSpeakerChanged);
  };
  const error = commandError ?? pollError;
  return <div className="speaker-volume-row" data-fixed={volume?.fixed || undefined}>
    <button type="button" disabled={sliderDisabled || isPending}
      aria-label={`${volume?.muted ? 'Unmute' : 'Mute'} ${speaker.name}`} title={`${volume?.muted ? 'Unmute' : 'Mute'} ${speaker.name}`}
      onClick={() => void setMuted(!volume?.muted).then(onSpeakerChanged)}>
      <MusicIcon name={volume?.muted ? 'volumeMute' : 'volume'} size={16} />
    </button>
    <span className="speaker-volume-name" title={speaker.name}>{speaker.name}</span>
    {volume?.fixed ? <span className="speaker-volume-fixed">Fixed volume</span> : <>
      <input type="range" min="0" max="100" value={displayed} disabled={sliderDisabled}
        className={touch ? undefined : 'volume-slider'} aria-label={`${speaker.name} volume`}
        onChange={event => setDraft(Number(event.target.value))}
        onPointerUp={event => commit(Number(event.currentTarget.value))}
        onPointerCancel={() => setDraft(null)}
        onKeyUp={event => commit(Number(event.currentTarget.value))} />
      <span className="speaker-volume-value" title={requestedVolume !== null ? 'Updating speaker volume…' : undefined}>
        {volume ? displayed : '—'}
      </span>
    </>}
    {error && <p className="speaker-volume-error" role="alert">{error}</p>}
  </div>;
}

export function SonosSpeakerVolumeButton({ speakers, groupName, disabled, ...listProps }: ListProps & { groupName: string }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const { refs: { setReference, setFloating }, floatingStyles, context } = useFloating({
    open, onOpenChange: setOpen, placement: 'bottom-end', strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 4 }), shift({ padding: 4 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    // Keep the list open while the group controls beside it move every speaker.
    useDismiss(context, { outsidePress: event => !(event.target instanceof Element && event.target.closest('.sonos-volume')) }),
    useRole(context, { role: 'dialog' }),
  ]);

  return <>
    <button type="button" ref={setReference} className="speaker-volume-trigger"
      aria-label="Speaker volumes" title="Speaker volumes" {...getReferenceProps()}>
      <MusicIcon name="speakers" size={16} />
    </button>
    {open && <FloatingPortal>
      <FloatingFocusManager context={context} modal={false}>
        <div ref={setFloating} style={floatingStyles} className="speaker-volume-popover"
          aria-labelledby={headingId} {...getFloatingProps()}>
          <h2 id={headingId}>{groupName} speakers</h2>
          <SonosSpeakerVolumeList speakers={speakers} disabled={disabled} {...listProps} />
        </div>
      </FloatingFocusManager>
    </FloatingPortal>}
  </>;
}
