export const PROD_PG_PORT: '5442';
export const I_MEAN_PROD: '--i-mean-prod';
export const HARNESS_URL_VARS: readonly string[];
export class MigrateTargetRefusal extends Error {}
export function onGithubRunner(env: Readonly<Record<string, string | undefined>>): boolean;
export function portOf(url: string): string;
export function describeTarget(url: string): string;
export function resolveMigrateTarget(
  env: Readonly<Record<string, string | undefined>>,
  opts?: { iMeanProd?: boolean },
): { url: string; source: string };
