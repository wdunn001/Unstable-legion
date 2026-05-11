/**
 * usePersona — load + update + persist the operator's `MeshPersona`.
 *
 * Single-flight semantics: load from localStorage once on mount; updates
 * write back synchronously and re-broadcast cap externally via the
 * caller (`MeshProvider.cap` listens for prop changes). Storage key is
 * overridable for multi-tenant setups.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PERSONA,
  loadPersona,
  savePersona,
  type MeshPersona,
} from '@unstable-legion/core';

export interface UsePersonaHandle {
  persona: MeshPersona;
  update: (patch: Partial<MeshPersona>) => void;
  reset: () => void;
}

export function usePersona(storageKey?: string): UsePersonaHandle {
  const [persona, setPersona] = useState<MeshPersona>(() => loadPersona(storageKey));

  // Keep storage in sync.
  useEffect(() => {
    savePersona(persona, storageKey);
  }, [persona, storageKey]);

  const update = useCallback((patch: Partial<MeshPersona>) => {
    setPersona((prev) => ({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setPersona(DEFAULT_PERSONA);
  }, []);

  return { persona, update, reset };
}
