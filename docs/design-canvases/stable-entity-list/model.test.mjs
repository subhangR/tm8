import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialState, siblings, descendants, move, create, flatten} from './model.mjs';
test('new roots and children enter at the top without changing existing relative order', () => {
  const original = initialState();
  const created = create(create(original,'task',null,'new-root'),'task','task-0','new-child');
  assert.equal(siblings(created,'task',null)[0].id,'new-root');
  assert.equal(siblings(created,'task','task-0')[0].id,'new-child');
  assert.deepEqual(flatten(created,'task').filter(r => !r.id.startsWith('new-')).map(r => r.id),flatten(original,'task').map(r => r.id));
});
test('lifecycle and unread changes cannot reorder any session', () => {
  const rows = initialState(), ids = flatten(rows,'session').map(r => r.id);
  for (const status of ['Working','Waiting for you','Completed']) {
    rows.find(r => r.id === 'session-0').status = status;
    rows.find(r => r.id === 'session-0').unread++;
    assert.deepEqual(flatten(rows,'session').map(r => r.id),ids);
  }
});
test('reparenting a parent preserves its descendants and supports manual session moves', () => {
  const rows = move(initialState(),'session-0','session-4');
  assert.equal(rows.find(r => r.id === 'session-0').parent,'session-4');
  assert.equal(rows.find(r => r.id === 'session-1').parent,'session-0');
  assert.deepEqual([...descendants(rows,'session-0')],['session-0','session-1','session-2']);
});
test('reordering is durable in the serialized model and only affects destination siblings', () => {
  const original = initialState(), moved = move(original,'task-5',null,'task-0');
  const restored = JSON.parse(JSON.stringify(moved));
  assert.deepEqual(siblings(restored,'task',null).map(r => r.id),['task-5','task-0','task-3','task-4']);
  assert.deepEqual(siblings(restored,'task','task-0'),siblings(original,'task','task-0'));
  assert.deepEqual(flatten(restored,'doc'),flatten(original,'doc'));
});
test('moves reject cycles, cross-kind nesting, and stale destinations', () => {
  const rows = initialState();
  assert.throws(() => move(rows,'task-0','task-1'),/descendants/);
  assert.throws(() => move(rows,'task-0','task-0'),/descendants/);
  assert.throws(() => move(rows,'task-0','session-0'),/same kind/);
  assert.throws(() => move(rows,'task-0',null,'missing'),/Destination/);
  assert.throws(() => create(rows,'task','session-0','bad'),/same kind/);
});
test('outdenting keeps children, and collapsing only changes visibility', () => {
  const rows = move(initialState(),'task-1',null,'task-3');
  assert.equal(rows.find(r => r.id === 'task-1').parent,null);
  assert.equal(flatten(rows,'task',new Set(['task-0'])).some(r => r.id === 'task-2'),false);
  assert.equal(flatten(rows,'task').some(r => r.id === 'task-2'),true);
});
