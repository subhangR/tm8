// A SessionHostRegistry over one JSON file, so a registration outlives the
// process that wrote it — exactly what internal.session_hosts gives the server.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function fileRegistry(path, nodeId = 'test-node') {
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
  const write = (rows) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(rows));
    renameSync(`${path}.tmp`, path);
  };
  return {
    nodeId,
    async list() {
      return read();
    },
    async insert(row) {
      const rows = read();
      if (rows.some((r) => r.generation === row.generation)) throw new Error(`duplicate generation ${row.generation}`);
      write([...rows, row]);
    },
    async setPid(generation, pid) {
      write(read().map((r) => (r.generation === generation ? { ...r, pid } : r)));
    },
    async remove(generation) {
      write(read().filter((r) => r.generation !== generation));
    },
    async ownerOf(generation) {
      return read().some((r) => r.generation === generation) ? nodeId : null;
    },
  };
}
