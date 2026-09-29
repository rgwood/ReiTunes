import { useState, useRef, useCallback, useEffect, type ReactNode, type PointerEvent } from 'react';
import {
  autoUpdate,
  useFloating,
  offset,
  flip,
  shift,
  FloatingPortal,
} from '@floating-ui/react';

interface TooltipProps {
  content: string;
  children: ReactNode;
  /** Always show tooltip on hover, even if text isn't truncated */
  force?: boolean;
}

interface OpenTooltip {
  reference: HTMLDivElement;
  content: string;
}

function listenForDismiss(onClose: () => void) {
  const dismiss = () => onClose();
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };
  window.addEventListener('scroll', dismiss, true);
  window.addEventListener('blur', dismiss);
  window.addEventListener('keydown', handleKeyDown);
  return () => {
    window.removeEventListener('scroll', dismiss, true);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('keydown', handleKeyDown);
  };
}

// A library can have thousands of tooltip triggers. Only the visible tooltip
// needs Floating UI's hooks, positioning observers, and portal.
function PositionedTooltip({ reference, content, onClose }: OpenTooltip & { onClose: () => void }) {
  const { refs, floatingStyles } = useFloating({
    elements: { reference },
    placement: 'top',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const setFloating = useCallback((node: HTMLDivElement | null) => {
    refs.setFloating(node);
  }, [refs]);

  useEffect(() => listenForDismiss(onClose), [onClose]);

  return (
    <FloatingPortal>
      <div
        ref={setFloating}
        style={floatingStyles}
        role="tooltip"
        className="z-50 px-2 py-1 text-xs bg-solarized-base02 text-solarized-base1 border border-solarized-base01 rounded shadow-lg max-w-80"
      >
        {content}
      </div>
    </FloatingPortal>
  );
}

export function Tooltip({ content, children, force }: TooltipProps) {
  const [openTooltip, setOpenTooltip] = useState<OpenTooltip | null>(null);
  const pendingHover = useRef<{
    timer: ReturnType<typeof setTimeout>;
    stopListening: () => void;
  } | null>(null);

  const cancelPendingHover = useCallback(() => {
    if (pendingHover.current !== null) {
      clearTimeout(pendingHover.current.timer);
      pendingHover.current.stopListening();
      pendingHover.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelPendingHover();
    setOpenTooltip(null);
  }, [cancelPendingHover]);

  useEffect(() => cancelPendingHover, [cancelPendingHover]);

  const handlePointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const reference = event.currentTarget;
    close();
    if (!force && reference.scrollWidth <= reference.clientWidth) return;
    const timer = setTimeout(() => {
      cancelPendingHover();
      if (!reference.isConnected || !reference.matches(':hover')
        || (!force && reference.scrollWidth <= reference.clientWidth)) return;
      setOpenTooltip({ reference, content });
    }, 200);
    pendingHover.current = { timer, stopListening: listenForDismiss(close) };
  };

  return (
    <>
      <div
        className="truncate"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={close}
        onPointerDown={close}
        onBlur={close}
      >
        {children}
      </div>
      {openTooltip?.content === content && (
        <PositionedTooltip {...openTooltip} onClose={close} />
      )}
    </>
  );
}
