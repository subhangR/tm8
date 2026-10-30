/**
 * Where a refused tool write lands on the form (`errors.ts`): the server's
 * zod issue paths name fields, a taken name is Name, and everything else is
 * the server's own message at the top — never a generic replacement.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import { definitionProblemOf, fieldKeyOf, issuesOf, placeIssues } from './errors';

describe('fieldKeyOf', () => {
  it('names the definition field a path points at, down to one input field', () => {
    expect(fieldKeyOf(['name'])).toBe('name');
    expect(fieldKeyOf(['timeoutSeconds'])).toBe('timeoutSeconds');
    expect(fieldKeyOf(['inputs'])).toBe('inputs');
    expect(fieldKeyOf(['inputs', 3])).toBe('inputs.3');
    expect(fieldKeyOf(['inputs', 3, 'default'])).toBe('inputs.3.default');
    // An unknown input member still marks the row.
    expect(fieldKeyOf(['inputs', 3, 'colour'])).toBe('inputs.3');
  });
  it('is null for anything the form has no field for', () => {
    expect(fieldKeyOf([])).toBeNull();
    expect(fieldKeyOf(['spaceId'])).toBeNull();
    expect(fieldKeyOf([0])).toBeNull();
  });
});

describe('issuesOf', () => {
  it('keeps only well-formed issues, with code and validation when present', () => {
    expect(issuesOf(undefined)).toEqual([]);
    expect(issuesOf([{ path: ['name'], message: 'Invalid', code: 'invalid_string', validation: 'regex' }, { path: 'name', message: 'x' }, { message: 'no path' }, 7]))
      .toEqual([{ path: ['name'], message: 'Invalid', code: 'invalid_string', validation: 'regex' }]);
  });
});

describe('placeIssues', () => {
  it('places issues under the prefix on fields, first message per field, and lists the rest with their path', () => {
    const placed = placeIssues([
      { path: ['definition', 'inputs', 1, 'min'], message: 'too small' },
      { path: ['definition', 'inputs', 1, 'min'], message: 'second, ignored' },
      { path: ['definition', 'help'], message: 'too long' },
      { path: ['clientMutationId'], message: 'Required' },
      { path: [], message: 'Unrecognized key' },
    ], ['definition']);
    expect(placed.fields).toEqual({ 'inputs.1.min': 'too small', help: 'too long' });
    expect(placed.unplaced).toEqual(['clientMutationId: Required', 'Unrecognized key']);
  });
});

describe('definitionProblemOf', () => {
  it('invalid_input with issue paths: fields marked, the server message heads the form', () => {
    const problem = definitionProblemOf(new CollabError('invalid_input', 'request body failed contract validation', {
      details: { issues: [{ code: 'too_small', path: ['definition', 'inputs', 3, 'default'], message: 'must be >= 1' }, { code: 'custom', path: ['definition', 'spaceId'], message: 'odd' }] },
    }));
    expect(problem).toEqual({ message: 'request body failed contract validation · definition.spaceId: odd', fields: { 'inputs.3.default': 'must be >= 1' } });
  });

  it('a taken name (SQLSTATE 23505, decided by code) is the Name field, in the server’s words', () => {
    expect(definitionProblemOf(new CollabError('invariant_violation', 'a live tool already has this name', { details: { sqlstate: '23505' } })))
      .toEqual({ message: null, fields: { name: 'a live tool already has this name' } });
    // Another invariant is not a name problem.
    expect(definitionProblemOf(new CollabError('invariant_violation', 'invalid tool limits', { details: { sqlstate: '22023' } })))
      .toEqual({ message: 'invalid tool limits', fields: {} });
  });

  it('a refusal without a path keeps the server message, and a plain error its text', () => {
    expect(definitionProblemOf(new CollabError('forbidden', 'only a human may create a tool'))).toEqual({ message: 'only a human may create a tool', fields: {} });
    expect(definitionProblemOf(new Error('network down'))).toEqual({ message: 'network down', fields: {} });
    expect(definitionProblemOf('odd')).toEqual({ message: 'The request could not be completed.', fields: {} });
  });
});
