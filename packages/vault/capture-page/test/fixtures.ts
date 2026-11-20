import { randomUUID } from 'node:crypto';
import type { ItemType } from '../src/contract.js';

/** Synthetic only. Credential-shaped strings are assembled at runtime. */
export function payloadFixture(type: ItemType): Record<string, unknown> {
  const suffix = randomUUID().replaceAll('-', '');
  const name = `Canary ${suffix}`;
  switch (type) {
    case 'login': return {
      type, name, username: `person-${suffix}`, password: ['test', suffix, 'only'].join('-'),
      origin: `https://capture-${suffix}.example.com`, totp: `CANARY${suffix.toUpperCase()}`,
      notes: `Private notes ${suffix} · ✓`,
    };
    case 'api_key': return { type, name, key: ['gh', 'p_', suffix, 'A'.repeat(10)].join(''), connector: `test_${suffix}` };
    case 'card': return {
      type, name, cardholder: `Cardholder ${suffix}`, pan: ['4242', '4242', '4242', '4242'].join(''),
      expMonth: 11, expYear: 2079,
    };
    case 'note': return { type, name, body: `Private note ${suffix} · ✓` };
    case 'identity': return { type, name, fields: { [`Field ${suffix}`]: `Private identity ${suffix}` } };
  }
}
