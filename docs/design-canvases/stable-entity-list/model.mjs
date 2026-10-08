// Prototype state only. Ordering is explicit; activity never participates in it.
export const kinds = {
  task: { label: 'Tasks', singular: 'task', icon: '◇' },
  session: { label: 'Sessions', singular: 'session', icon: '⌘' },
  doc: { label: 'Docs', singular: 'doc', icon: '▤' },
  artifact: { label: 'Artifacts', singular: 'artifact', icon: '▧' },
};
export function initialState() {
  const rows = [];
  const titles = {
    task: ['Entity list redesign', 'Stable placement', 'Inline title creation', 'Keyboard interactions', 'Workspace polish', 'Review empty states'],
    session: ['Panel design exploration', 'Interaction prototype', 'Motion review', 'Accessibility pass', 'Workspace research', 'Review findings'],
    doc: ['Workspace design', 'Placement principles', 'Creation flow', 'Keyboard reference', 'Product notes', 'Review checklist'],
    artifact: ['Entity panel prototype', 'Stable tree study', 'Creation study', 'Motion study', 'Workspace concepts', 'Review canvas'],
  };
  for (const kind of Object.keys(kinds)) titles[kind].forEach((title, i) => rows.push({
    id: `${kind}-${i}`, kind, title, parent: i === 1 || i === 2 ? `${kind}-0` : null,
    order: i, status: i === 0 ? 'Working' : i === 4 ? 'Completed' : 'Open', unread: 0,
    description: i === 0 ? 'Keep the workspace easy to navigate as work happens. Create and organize here, then use the detail tab to add context.' : '',
  }));
  return rows;
}
export const siblings = (rows, kind, parent) => rows.filter(r => r.kind === kind && r.parent === parent).sort((a,b) => a.order-b.order);
export function descendants(rows, id) {
  const ids = new Set([id]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.id)) { ids.add(row.id); changed = true; } }
  return ids;
}
export function move(rows, id, parent, before = null) {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error('Entity not found');
  if (parent !== null) {
    const target = rows.find(r => r.id === parent);
    if (!target || target.kind !== row.kind) throw new Error('Choose a parent of the same kind');
    if (descendants(rows, id).has(parent)) throw new Error('An entity cannot be moved into itself or its descendants');
  }
  const peers = siblings(rows, row.kind, parent).filter(r => r.id !== id);
  const at = before === null ? peers.length : peers.findIndex(r => r.id === before);
  if (at < 0) throw new Error('Destination changed');
  peers.splice(at, 0, {...row, parent});
  const updated = new Map(peers.map((r, order) => [r.id, {...r, order}]));
  return rows.map(r => updated.get(r.id) ?? r);
}
export function create(rows, kind, parent, id) {
  if (parent !== null && !rows.some(r => r.id === parent && r.kind === kind)) throw new Error('Choose a parent of the same kind');
  const peers = siblings(rows, kind, parent);
  return [...rows, {id, kind, parent, order: (peers[0]?.order ?? 0)-1, title: '', description: '', status: 'Open', unread: 0}];
}
export function flatten(rows, kind, collapsed = new Set(), parent = null, depth = 0) {
  return siblings(rows, kind, parent).flatMap(row => [{...row, depth}, ...(!collapsed.has(row.id) ? flatten(rows, kind, collapsed, row.id, depth+1) : [])]);
}
