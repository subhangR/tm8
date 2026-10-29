import { Fragment } from 'react';
import { ToolInputSchema, type ToolInput } from '@tm8/contract';
import type { FieldErrors } from './errors';

export interface InputDraft {
  name: string; type: ToolInput['type']; required: boolean; description: string;
  flag: string; short: string; env: string; options: string; defaultValue: string; min: string; max: string;
}
export const newInput = (): InputDraft => ({ name: '', type: 'string', required: false, description: '', flag: '', short: '', env: '', options: '', defaultValue: '', min: '', max: '' });
export function draftInput(input: ToolInput): InputDraft {
  return { ...newInput(), ...input, options: input.type === 'enum' ? input.options.join('\n') : '',
    defaultValue: 'default' in input && input.default !== undefined ? input.type === 'string' || input.type === 'path' || input.type === 'enum' ? String(input.default) : JSON.stringify(input.default) : '',
    min: 'min' in input && input.min !== undefined ? String(input.min) : '', max: 'max' in input && input.max !== undefined ? String(input.max) : '' };
}
export function inputFromDraft(row: InputDraft): ToolInput {
  const optional = Object.fromEntries(['description', 'flag', 'short', 'env'].filter(key => row[key as keyof InputDraft] !== '').map(key => [key, row[key as keyof InputDraft]]));
  const numeric = row.type === 'int' || row.type === 'number';
  let defaultValue: unknown;
  if (row.defaultValue !== '' && row.type !== 'secret') {
    try { defaultValue = ['bool', 'int', 'number', 'json'].includes(row.type) ? JSON.parse(row.defaultValue) : row.defaultValue; }
    catch { throw new Error(`${row.name || 'Input'}: default must be valid ${row.type}.`); }
  }
  return ToolInputSchema.parse({ ...optional, name: row.name, type: row.type, required: row.required,
    ...(row.type === 'enum' ? { options: row.options.split('\n').map(value => value.trim()).filter(Boolean) } : {}),
    ...(numeric && row.min !== '' ? { min: Number(row.min) } : {}), ...(numeric && row.max !== '' ? { max: Number(row.max) } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}) });
}
const TYPES: ToolInput['type'][] = ['string', 'int', 'number', 'bool', 'enum', 'json', 'path', 'secret'];
const DETAIL_FIELDS = ['description', 'flag', 'short', 'env', 'options', 'default', 'min', 'max'] as const;
/** `errors` uses the definition's paths: `inputs.2` for a whole row, `inputs.2.default` for one field. */
export function InputsEditor({ rows, onChange, errors = {} }: { rows: InputDraft[]; onChange(rows: InputDraft[]): void; errors?: FieldErrors }) {
  const change = (index: number, patch: Partial<InputDraft>) => onChange(rows.map((row, at) => at === index ? { ...row, ...patch } : row));
  const problem = (index: number, field?: string) => errors[field ? `inputs.${index}.${field}` : `inputs.${index}`];
  const invalid = (index: number, field: string) => problem(index, field) ? { 'aria-invalid': true as const } : {};
  const note = (index: number, field?: string) => problem(index, field) ? <span className="tool-field-error" role="alert">{problem(index, field)}</span> : null;
  return <section aria-label="Input definitions"><h3>Inputs</h3><div className="tool-table-scroll"><table className="tool-inputs"><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Details</th><th scope="col">Remove</th></tr></thead><tbody>
    {rows.map((row, index) => <Fragment key={index}><tr>
      <td><input aria-label={`Input ${index + 1} name`} value={row.name} onChange={event => change(index, { name: event.target.value })} required pattern="[a-z][a-z0-9_]{0,63}" {...invalid(index, 'name')} />{note(index, 'name')}</td>
      <td><select aria-label={`Input ${index + 1} type`} value={row.type} onChange={event => change(index, { type: event.target.value as ToolInput['type'], defaultValue: '', min: '', max: '', options: '' })} {...invalid(index, 'type')}>{TYPES.map(type => <option key={type}>{type}</option>)}</select>{note(index, 'type')}</td>
      <td><input type="checkbox" aria-label={`Input ${index + 1} required`} checked={row.required} onChange={event => change(index, { required: event.target.checked })} /></td>
      <td><details open={DETAIL_FIELDS.some(field => problem(index, field)) || undefined}><summary>{row.description || 'Options'}</summary><div className="tool-input-details">
        {(['description', 'flag', 'short', 'env'] as const).map(key => <label key={key}>{key}<input aria-label={`Input ${index + 1} ${key}`} value={row[key]} onChange={event => change(index, { [key]: event.target.value })} {...invalid(index, key)} />{note(index, key)}</label>)}
        {row.type === 'enum' && <label>Options (one per line)<textarea aria-label={`Input ${index + 1} options`} value={row.options} onChange={event => change(index, { options: event.target.value })} {...invalid(index, 'options')} />{note(index, 'options')}</label>}
        {row.type !== 'secret' && <label>Default<input aria-label={`Input ${index + 1} default`} value={row.defaultValue} onChange={event => change(index, { defaultValue: event.target.value })} {...invalid(index, 'default')} />{note(index, 'default')}</label>}
        {(row.type === 'int' || row.type === 'number') && (['min', 'max'] as const).map(key => <label key={key}>{key}<input type="number" aria-label={`Input ${index + 1} ${key}`} value={row[key]} onChange={event => change(index, { [key]: event.target.value })} {...invalid(index, key)} />{note(index, key)}</label>)}
      </div></details></td>
      <td><button type="button" className="pn-btn" aria-label={`Remove input ${index + 1}`} onClick={() => onChange(rows.filter((_, at) => at !== index))}>Remove</button></td>
    </tr>{problem(index) && <tr className="tool-input-problem"><td colSpan={5}>{note(index)}</td></tr>}</Fragment>)}
  </tbody></table></div>{errors.inputs && <span className="tool-field-error" role="alert">{errors.inputs}</span>}<button type="button" className="pn-btn" disabled={rows.length >= 64} onClick={() => onChange([...rows, newInput()])}>Add input</button></section>;
}
