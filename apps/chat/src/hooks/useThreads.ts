/**
 * useThreads — conversation-list state backed by `db/threadStore.ts`.
 * Owns the in-memory thread list + active thread id; every mutation
 * writes through to IndexedDB so a reload picks up exactly where the
 * user left off (see App.tsx's product e2e "persists across reload").
 *
 * Streaming updates (token-by-token assistant text) are NOT persisted on
 * every token — that would hammer IndexedDB for no benefit (a mid-token
 * crash losing the last few dozen characters of an in-flight reply is an
 * acceptable loss; the thread + every prior turn is never at risk,
 * because the user's own message and the assistant placeholder are
 * persisted immediately on send). `flushActiveThread` persists the
 * current in-memory state; callers debounce it during streaming and call
 * it unconditionally on stream completion/abort/error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  autoTitle,
  deleteThread as dbDeleteThread,
  getThread,
  listThreads,
  newId,
  putThread,
  type ChatMessage,
  type ChatThread,
} from '../db/threadStore.js';

export interface UseThreadsHandle {
  threads: readonly ChatThread[];
  activeThreadId: string | undefined;
  activeThread: ChatThread | undefined;
  loaded: boolean;
  newThread: () => string;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => Promise<void>;
  /** Append a message to the active thread (creating one first if none
   * is selected), persist immediately, and return the new message id. */
  appendMessage: (role: ChatMessage['role'], content: string) => string;
  /** Overwrite a message's content in-place (streaming updates) — does
   * NOT persist by itself; call `flushActiveThread` to save. */
  updateMessageContent: (messageId: string, content: string) => void;
  /** Replace a message's tool-activity trace (TOOL-NODES chips) — same
   * in-memory-until-flush semantics as `updateMessageContent`. */
  setMessageToolTrace: (messageId: string, toolTrace: readonly string[]) => void;
  /** Mark a message as having recovered from a mid-stream host death. */
  markReconnected: (messageId: string) => void;
  /** Persist the current in-memory active thread to IndexedDB. */
  flushActiveThread: () => Promise<void>;
}

function emptyThread(id: string): ChatThread {
  const now = Date.now();
  return { id, title: 'New chat', messages: [], createdAt: now, updatedAt: now };
}

export function useThreads(): UseThreadsHandle {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  // Mutable mirror of `threads` so synchronous append/update calls (fired
  // from streaming callbacks that may run several times per animation
  // frame) never race a stale closure over the `useState` value.
  const threadsRef = useRef<ChatThread[]>([]);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  // Mutable mirror of `activeThreadId`, updated SYNCHRONOUSLY (not via an
  // effect) every time it changes — `doSend` in App.tsx calls
  // `appendMessage('user', …)` immediately followed by
  // `appendMessage('assistant', …)` in the same synchronous tick. The
  // first call creates a fresh thread and schedules `setActiveThreadId`,
  // but React state updates don't apply until the next render — reading
  // the closed-over `activeThreadId` STATE value in `withActiveThread`
  // would see the OLD (still-undefined) id on the second call and create
  // a SECOND new thread, silently splitting the user message and the
  // assistant placeholder across two different conversations. Reading
  // `activeThreadIdRef.current` instead (set synchronously alongside
  // every `setActiveThreadId` call below) fixes that.
  const activeThreadIdRef = useRef<string | undefined>(undefined);
  const setActiveId = useCallback((id: string | undefined) => {
    activeThreadIdRef.current = id;
    setActiveThreadId(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listThreads().then((loadedThreads) => {
      if (cancelled) return;
      setThreads(loadedThreads);
      threadsRef.current = loadedThreads;
      if (loadedThreads.length > 0) setActiveId(loadedThreads[0]!.id);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [setActiveId]);

  const newThread = useCallback((): string => {
    const id = newId('thread');
    const thread = emptyThread(id);
    threadsRef.current = [thread, ...threadsRef.current];
    setThreads(threadsRef.current);
    setActiveId(id);
    void putThread(thread);
    return id;
  }, [setActiveId]);

  const selectThread = useCallback(
    (id: string) => {
      setActiveId(id);
    },
    [setActiveId],
  );

  const deleteThreadFn = useCallback(
    async (id: string) => {
      threadsRef.current = threadsRef.current.filter((t) => t.id !== id);
      setThreads(threadsRef.current);
      if (activeThreadIdRef.current === id) setActiveId(threadsRef.current[0]?.id);
      await dbDeleteThread(id);
    },
    [setActiveId],
  );

  const withActiveThread = useCallback(
    (mutate: (thread: ChatThread) => ChatThread): ChatThread => {
      let id = activeThreadIdRef.current;
      let list = threadsRef.current;
      if (!id || !list.some((t) => t.id === id)) {
        id = newId('thread');
        list = [emptyThread(id), ...list];
      }
      const updated = list.map((t) => (t.id === id ? mutate(t) : t));
      threadsRef.current = updated;
      setThreads(updated);
      setActiveId(id);
      return updated.find((t) => t.id === id)!;
    },
    [setActiveId],
  );

  const appendMessage = useCallback(
    (role: ChatMessage['role'], content: string): string => {
      const messageId = newId('msg');
      const thread = withActiveThread((t) => {
        const messages = [...t.messages, { id: messageId, role, content, createdAt: Date.now() }];
        const title = t.messages.length === 0 && role === 'user' ? autoTitle(content) : t.title;
        return { ...t, messages, title, updatedAt: Date.now() };
      });
      void putThread(thread);
      return messageId;
    },
    [withActiveThread],
  );

  const updateMessageContent = useCallback(
    (messageId: string, content: string) => {
      withActiveThread((t) => ({
        ...t,
        messages: t.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
        updatedAt: Date.now(),
      }));
    },
    [withActiveThread],
  );

  const setMessageToolTrace = useCallback(
    (messageId: string, toolTrace: readonly string[]) => {
      withActiveThread((t) => ({
        ...t,
        messages: t.messages.map((m) => (m.id === messageId ? { ...m, toolTrace: [...toolTrace] } : m)),
        updatedAt: Date.now(),
      }));
    },
    [withActiveThread],
  );

  const markReconnected = useCallback(
    (messageId: string) => {
      withActiveThread((t) => ({
        ...t,
        messages: t.messages.map((m) => (m.id === messageId ? { ...m, reconnected: true } : m)),
      }));
    },
    [withActiveThread],
  );

  const flushActiveThread = useCallback(async () => {
    const id = activeThreadIdRef.current;
    const thread = threadsRef.current.find((t) => t.id === id);
    if (thread) await putThread(thread);
  }, []);

  const activeThread = threads.find((t) => t.id === activeThreadId);

  return {
    threads,
    activeThreadId,
    activeThread,
    loaded,
    newThread,
    selectThread,
    deleteThread: deleteThreadFn,
    appendMessage,
    updateMessageContent,
    setMessageToolTrace,
    markReconnected,
    flushActiveThread,
  };
}

/** Re-fetch a single thread from IndexedDB — used by the reload/persist
 * e2e path to prove the write actually landed, independent of in-memory
 * state. Exported mainly for tests. */
export { getThread };
