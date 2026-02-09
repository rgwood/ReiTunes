import { useState, useRef, useCallback, type ReactNode } from 'react';
import {
  useFloating,
  useHover,
  useInteractions,
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

export function Tooltip({ content, children, force }: TooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = useCallback((open: boolean) => {
    // Only show tooltip if text is actually truncated (unless forced)
    if (open && !force && triggerRef.current) {
      if (triggerRef.current.scrollWidth <= triggerRef.current.clientWidth) {
        return;
      }
    }
    setIsOpen(open);
  }, [force]);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: handleOpenChange,
    placement: 'top',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  const hover = useHover(context, { delay: { open: 200, close: 0 } });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover]);

  return (
    <>
      <div
        ref={(node) => {
          refs.setReference(node);
          (triggerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        className="truncate"
        {...getReferenceProps()}
      >
        {children}
      </div>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50 px-2 py-1 text-xs bg-solarized-base02 text-solarized-base1 border border-solarized-base01 rounded shadow-lg max-w-80"
            {...getFloatingProps()}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
