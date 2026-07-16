/**
 * useMobileCollapse — collapsed-by-default-on-mobile state for the chat
 * app's sidebar strips (ConversationList / MeshSidebar).
 *
 * Same semantics as mesh-react's MeshRosterPanel (its helper is
 * module-private, so the ~15 lines are duplicated here rather than
 * widening that package's public API):
 *   - initial state: collapsed iff the viewport is mobile-width;
 *   - a resize DOWN to mobile auto-collapses;
 *   - a resize UP never auto-expands (the user may have collapsed on
 *     purpose — desktop CSS hides the toggle and shows the full panel
 *     regardless, so a stale `collapsed=true` is invisible there).
 */
import { useEffect, useState } from 'react';

export const MOBILE_BREAKPOINT_PX = 720;

export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

export function useMobileCollapse(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => isMobileViewport());

  useEffect(() => {
    let wasMobile = isMobileViewport();
    const onResize = () => {
      const nowMobile = isMobileViewport();
      if (nowMobile && !wasMobile) setCollapsed(true);
      wasMobile = nowMobile;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return [collapsed, setCollapsed];
}
