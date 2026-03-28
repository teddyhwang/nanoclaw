import { useEffect, useRef, useCallback } from 'react';

const THRESHOLD = 80;
const MAX_PULL = 140;
const RESISTANCE = 0.45;

/**
 * Find the first scrollable child within a container.
 */
function findScrollable(el: HTMLElement): HTMLElement | null {
  const children = el.querySelectorAll('*');
  for (const child of children) {
    if (child instanceof HTMLElement) {
      const style = getComputedStyle(child);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        child.scrollHeight > child.clientHeight
      ) {
        return child;
      }
    }
  }
  return el;
}

/**
 * Pull-to-refresh for standalone PWA mode.
 * Pulls the entire page down with rubber-band feel, then reloads.
 */
export function usePullToRefresh(
  containerRef: React.RefObject<HTMLElement | null>,
) {
  const startY = useRef(0);
  const pulling = useRef(false);
  const indicatorEl = useRef<HTMLDivElement | null>(null);

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);

  const getIndicator = useCallback(() => {
    if (indicatorEl.current) return indicatorEl.current;
    const el = document.createElement('div');
    el.className = 'ptr-indicator';
    el.innerHTML = '<div class="ptr-spinner"></div>';
    document.body.appendChild(el);
    indicatorEl.current = el;
    return el;
  }, []);

  useEffect(() => {
    if (!isStandalone) return;
    const container = containerRef.current;
    if (!container) return;

    let scrollEl: HTMLElement | null = null;

    const getScrollEl = () => {
      if (!scrollEl || !container.contains(scrollEl)) {
        scrollEl = findScrollable(container);
      }
      return scrollEl;
    };

    const onTouchStart = (e: TouchEvent) => {
      const el = getScrollEl();
      if (el && el.scrollTop <= 0) {
        startY.current = e.touches[0].clientY;
        pulling.current = true;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pulling.current) return;
      const rawDy = e.touches[0].clientY - startY.current;
      if (rawDy < 0) {
        pulling.current = false;
        container.style.transform = '';
        container.style.transition = '';
        const indicator = getIndicator();
        indicator.style.transform = 'translateY(0)';
        indicator.style.opacity = '0';
        return;
      }

      // Rubber-band resistance
      const pull = Math.min(rawDy * RESISTANCE, MAX_PULL);
      const progress = Math.min(pull / THRESHOLD, 1);

      // Move the entire page down
      container.style.transform = `translateY(${pull}px)`;
      container.style.transition = 'none';

      // Show spinner above the pulled content, rotating with pull
      const indicator = getIndicator();
      const rotation = (pull / MAX_PULL) * 360;
      indicator.style.transform = `translateY(${pull * 0.4}px)`;
      indicator.style.opacity = String(progress);
      const spinner = indicator.firstElementChild as HTMLElement;
      if (spinner) spinner.style.transform = `rotate(${rotation}deg)`;
      indicator.classList.toggle('ptr-ready', pull >= THRESHOLD);

      if (rawDy > 10) {
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {
      if (!pulling.current) return;
      pulling.current = false;
      const indicator = getIndicator();
      const ready = indicator.classList.contains('ptr-ready');

      if (ready) {
        // Snap to refreshing position
        container.style.transition =
          'transform 0.3s cubic-bezier(0.2, 0, 0, 1)';
        container.style.transform = 'translateY(60px)';
        indicator.classList.add('ptr-refreshing');
        indicator.style.transition =
          'transform 0.3s cubic-bezier(0.2, 0, 0, 1)';
        indicator.style.transform = 'translateY(24px)';
        indicator.style.opacity = '1';
        window.location.reload();
      } else {
        // Snap back
        container.style.transition =
          'transform 0.3s cubic-bezier(0.2, 0, 0, 1)';
        container.style.transform = '';
        indicator.style.transition = 'transform 0.3s, opacity 0.3s';
        indicator.style.transform = 'translateY(0)';
        indicator.style.opacity = '0';
        indicator.classList.remove('ptr-ready');
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.style.transform = '';
      container.style.transition = '';
      if (indicatorEl.current) {
        indicatorEl.current.remove();
        indicatorEl.current = null;
      }
    };
  }, [isStandalone, containerRef, getIndicator]);
}
