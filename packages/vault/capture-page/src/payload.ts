import { isLabelSafe } from './contract.js';
import type { ItemType } from './contract.js';
import { PageError } from './errors.js';

export interface Field {
  key: string; label: string; kind?: 'password' | 'textarea' | 'url' | 'number';
  required?: boolean; max: number; min?: number; upper?: number; pattern?: string;
}
const NAME: Field = { key: 'name', label: 'Item name', required: true, max: 200 };
export const CAPTURE_FIELDS: Record<ItemType, readonly Field[]> = {
  login: [NAME,
    { key: 'username', label: 'Username', max: 512 },
    { key: 'password', label: 'Password', kind: 'password', required: true, max: 4096 },
    { key: 'origin', label: 'Exact HTTPS origin', kind: 'url', required: true, max: 2048 },
    { key: 'totp', label: 'TOTP seed (optional)', kind: 'password', max: 2048 },
    { key: 'notes', label: 'Notes (optional)', kind: 'textarea', max: 65536 },
  ],
  api_key: [NAME,
    { key: 'key', label: 'API key', kind: 'password', required: true, min: 8, max: 16384 },
    { key: 'connector', label: 'Connector (optional)', max: 64, pattern: '^[a-z][a-z0-9_-]{0,63}$' },
  ],
  card: [NAME,
    { key: 'cardholder', label: 'Cardholder (optional)', max: 200 },
    { key: 'pan', label: 'Card number', kind: 'password', required: true, max: 32 },
    { key: 'expMonth', label: 'Expiry month', kind: 'number', required: true, min: 1, upper: 12, max: 2 },
    { key: 'expYear', label: 'Expiry year', kind: 'number', required: true, min: 2000, upper: 2100, max: 4 },
  ],
  note: [NAME, { key: 'body', label: 'Secure note', kind: 'textarea', required: true, max: 65536 }],
  identity: [NAME],
};

const CVV = /^(cvv2?|cvc2?|csc|cid|cav2|cvn|card_?verification(_?(value|code))?|security_?code|securitycode)$/i;

function luhn(value: string): boolean {
  let sum = 0;
  let twice = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number(value[i]);
    if (twice) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit; twice = !twice;
  }
  return sum % 10 === 0;
}

/** Validates locally with fixed errors. The broker remains authoritative. */
export function buildPayload(form: HTMLFormElement, type: ItemType): Record<string, unknown> {
  const payload: Record<string, unknown> = { type };
  for (const field of CAPTURE_FIELDS[type]) {
    const input = form.elements.namedItem(field.key) as HTMLInputElement | HTMLTextAreaElement | null;
    let value = input?.value ?? '';
    if (field.key === 'name') value = value.trim();
    if ((!value && field.required) || value.length > field.max) throw new PageError('invalid_payload');
    // C6: a name or username is a label people read; the broker refuses the same characters.
    if ((field.key === 'name' || field.key === 'username') && !isLabelSafe(value)) throw new PageError('unsafe_label');
    if (!value) continue;
    if (field.kind === 'number') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < (field.min ?? 0) || number > (field.upper ?? Infinity)) throw new PageError('invalid_payload');
      payload[field.key] = number;
    } else {
      if (field.min !== undefined && value.length < field.min) throw new PageError('invalid_payload');
      if (field.pattern && !new RegExp(field.pattern).test(value)) throw new PageError('invalid_payload');
      payload[field.key] = value;
    }
  }
  if (type === 'login') {
    try {
      const origin = new URL(String(payload.origin));
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || (origin.pathname && origin.pathname !== '/')) throw new PageError('invalid_payload');
    } catch { throw new PageError('invalid_payload'); }
  }
  if (type === 'card') {
    const pan = String(payload.pan).replace(/[\s-]/g, '');
    if (!/^[0-9]{12,19}$/.test(pan) || !luhn(pan)) throw new PageError('invalid_payload');
    payload.pan = pan;
  }
  if (type === 'identity') {
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const row of form.querySelectorAll<HTMLElement>('[data-identity-row]')) {
      const key = row.querySelector<HTMLInputElement>('[data-identity-key]')?.value ?? '';
      const value = row.querySelector<HTMLInputElement>('[data-identity-value]')?.value ?? '';
      if (!/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/.test(key) || CVV.test(key.replace(/[\s-]/g, '_')) || Object.hasOwn(fields, key) || value.length > 4096) throw new PageError('invalid_payload');
      fields[key] = value;
    }
    if (Object.keys(fields).length < 1 || Object.keys(fields).length > 50) throw new PageError('invalid_payload');
    payload.fields = fields;
  }
  return payload;
}
