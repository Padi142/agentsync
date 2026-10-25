import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

/**
 * `navigate` for the end of async work, such as a save. Once the page that started the work
 * has unmounted (the user left it, or moved to another Machine or Conflict), the work no
 * longer owns the screen, so navigating would take the user away from another page.
 */
export function useOwnNavigate() {
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback(
    ((options) => (mounted.current ? navigate(options) : Promise.resolve())) as typeof navigate,
    [navigate],
  );
}
