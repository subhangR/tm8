/**
 * Zod ↔ SQL parity for form validation (Forms W0 gate).
 *
 * `internal.validate_form_answers` is the authority at submit; the contract's
 * `validateFormAnswers` mirrors it so the CLI and UI fail early. If the two
 * drift, a form either refuses in the browser what the server would accept,
 * or — worse — lets a user compose answers the server then rejects. Neither
 * shows up in a suite that tests one side only.
 *
 * So every case in the SHARED fixture (packages/contract/test/fixtures/
 * form-parity.ts) runs through BOTH validators here, and the verdicts
 * (`key:code`, sorted) must equal each other AND the fixture's expectation.
 * The same holds for question configs. Adding a question type adds its cases
 * to that fixture; this file does not change.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formQuestionConfigIssues, validateFormAnswers } from '@tm8/contract';

import {
  ANSWER_CASES,
  CONFIG_CASES,
  PARITY_QUESTIONS,
  verdict,
} from '../../../contract/test/fixtures/form-parity.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let db: W1ScratchDatabase;

interface SqlIssue { key?: string; code: string }

async function sqlAnswers(answers: unknown, final: boolean): Promise<SqlIssue[]> {
  const rows = await db.query<{ issues: SqlIssue[] }>(
    `select internal.validate_form_answers_against($1::jsonb, $2::jsonb, $3) issues`,
    [JSON.stringify(PARITY_QUESTIONS), JSON.stringify(answers), final],
  );
  return rows[0]!.issues;
}

async function sqlConfig(type: string, config: unknown): Promise<SqlIssue[]> {
  const rows = await db.query<{ issues: SqlIssue[] }>(
    `select internal.form_question_config_issues($1, $2::jsonb) issues`,
    [type, JSON.stringify(config)],
  );
  return rows[0]!.issues;
}

beforeAll(async () => {
  db = await createW1ScratchDatabase('forms_parity');
  db.apply(migrationFiles());
});

afterAll(async () => {
  await db?.destroy();
});

describe('answers: SQL and Zod return the same verdict for every fixture case', () => {
  it('the fixture questions are valid on both sides', async () => {
    for (const q of PARITY_QUESTIONS) {
      expect(verdict(await sqlConfig(q.type, q.config)), `${q.key} (sql)`).toEqual([]);
      expect(verdict(formQuestionConfigIssues(q.type, q.config)), `${q.key} (zod)`).toEqual([]);
    }
  });

  for (const c of ANSWER_CASES) {
    it(`${c.final ? 'final' : 'draft'}: ${c.name}`, async () => {
      const sql = verdict(await sqlAnswers(c.answers, c.final));
      const zod = verdict(validateFormAnswers(PARITY_QUESTIONS, c.answers, { final: c.final }));
      expect({ sql, zod }).toEqual({ sql: c.expect, zod: c.expect });
    });
  }
});

describe('question configs: SQL and Zod agree', () => {
  for (const c of CONFIG_CASES) {
    it(c.name, async () => {
      const sql = verdict(await sqlConfig(c.type, c.config));
      const zod = verdict(formQuestionConfigIssues(c.type, c.config));
      expect({ sql, zod }).toEqual({ sql: c.expect, zod: c.expect });
    });
  }
});

describe('the SQL issues carry what the 422 body needs', () => {
  it('every issue has a key, a code and a message', async () => {
    const issues = await sqlAnswers({ sc: { value: 'q' }, zz: {} }, true);
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues as Array<Record<string, unknown>>) {
      expect(Object.keys(i).sort()).toEqual(['code', 'key', 'message']);
      expect(typeof i['message']).toBe('string');
    }
  });
});
