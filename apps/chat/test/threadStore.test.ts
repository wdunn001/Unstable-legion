/**
 * threadStore unit tests — real IndexedDB semantics via `fake-indexeddb`
 * (Node has no native IndexedDB), so these exercise the actual async
 * transaction/request lifecycle the browser build depends on, not a
 * hand-mocked stand-in.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetDbHandleForTests,
  autoTitle,
  deleteThread,
  getThread,
  listThreads,
  newId,
  putThread,
  type ChatThread,
} from '../src/db/threadStore.ts';

test.beforeEach(async () => {
  await _resetDbHandleForTests();
});

function makeThread(id: string, updatedAt: number): ChatThread {
  return {
    id,
    title: `thread ${id}`,
    messages: [{ id: `${id}-m1`, role: 'user', content: 'hi', createdAt: updatedAt }],
    createdAt: updatedAt,
    updatedAt,
  };
}

test('putThread + getThread round-trips a thread', async () => {
  const thread = makeThread('t1', 1000);
  await putThread(thread);
  const fetched = await getThread('t1');
  assert.deepEqual(fetched, thread);
});

test('getThread returns undefined for a missing id', async () => {
  const fetched = await getThread('does-not-exist');
  assert.equal(fetched, undefined);
});

test('listThreads returns most-recently-updated first', async () => {
  await putThread(makeThread('old', 100));
  await putThread(makeThread('newest', 300));
  await putThread(makeThread('middle', 200));
  const threads = await listThreads();
  assert.deepEqual(
    threads.map((t) => t.id),
    ['newest', 'middle', 'old'],
  );
});

test('putThread overwrites an existing thread by id', async () => {
  await putThread(makeThread('t1', 100));
  const updated = { ...makeThread('t1', 200), title: 'renamed' };
  await putThread(updated);
  const threads = await listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.title, 'renamed');
});

test('deleteThread removes it from listThreads', async () => {
  await putThread(makeThread('keep', 100));
  await putThread(makeThread('gone', 200));
  await deleteThread('gone');
  const threads = await listThreads();
  assert.deepEqual(
    threads.map((t) => t.id),
    ['keep'],
  );
});

test('autoTitle truncates long first messages and falls back for empty input', () => {
  assert.equal(autoTitle(undefined), 'New chat');
  assert.equal(autoTitle('   '), 'New chat');
  assert.equal(autoTitle('short question'), 'short question');
  const long = 'a'.repeat(80);
  const title = autoTitle(long);
  assert.ok(title.length <= 49);
  assert.ok(title.endsWith('…'));
});

test('newId produces unique, prefixed ids', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newId('thread')));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id.startsWith('thread-'));
});
