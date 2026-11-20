/** A strict RFC 4180 reader. Values are accumulated independently of the source. */
export function readCsv(
  text: string,
  refuse: (code: 'malformed_csv' | 'field_too_large' | 'too_many_rows') => never,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  let touched = false;
  const finishField = () => {
    if (Buffer.byteLength(field, 'utf8') > 65536) refuse('field_too_large');
    row.push(field);
    field = '';
    closed = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    if (rows.length > 10001) refuse('too_many_rows');
    row = [];
    touched = false;
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; closed = true; }
      } else field += ch;
    } else if (ch === ',') {
      finishField();
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r') {
        if (text[i + 1] !== '\n') refuse('malformed_csv');
        i += 1;
      }
      finishRow();
    } else {
      if (closed) refuse('malformed_csv');
      if (ch === '"') {
        if (field.length !== 0) refuse('malformed_csv');
        quoted = true;
      } else field += ch;
      touched = true;
    }
    // Byte length is checked at each delimiter. This additional bound prevents
    // oversized unterminated fields from allocating the whole input first.
    if (field.length > 65536) refuse('field_too_large');
  }
  if (quoted) refuse('malformed_csv');
  if (touched || row.length !== 0 || field.length !== 0 || closed) finishRow();
  return rows;
}
