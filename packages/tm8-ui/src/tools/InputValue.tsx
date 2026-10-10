import type { ToolInput } from '@tm8/contract';

export function InputValue({ input, value, onChange, disabled, label = input.name }: { input: ToolInput; value: string; onChange(value: string): void; disabled?: boolean; label?: string }) {
  if (input.type === 'bool' || input.type === 'enum') return <select aria-label={label} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
    <option value="">Not set</option>
    {(input.type === 'bool' ? ['true', 'false'] : input.options).map(option => <option key={option} value={option}>{option}</option>)}
  </select>;
  if (input.type === 'json') return <textarea aria-label={label} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} rows={3} spellCheck={false} />;
  return <input aria-label={label} type={input.type === 'secret' ? 'password' : input.type === 'int' || input.type === 'number' ? 'number' : 'text'} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}
    {...(input.type === 'int' || input.type === 'number' ? { min: input.min, max: input.max, step: input.type === 'int' ? 1 : 'any' } : {})}
    {...(input.type === 'secret' ? { autoComplete: 'off' } : {})} />;
}
