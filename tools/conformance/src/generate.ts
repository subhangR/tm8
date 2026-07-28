import { checkW1ConformanceManifest, writeW1ConformanceManifest } from './foundations/generator.js';

const check = process.argv.includes('--check');

try {
  if (check) {
    await checkW1ConformanceManifest();
    console.log('[conformance] generated W1 evidence is current');
  } else {
    await writeW1ConformanceManifest();
    console.log('[conformance] generated W1 evidence refreshed');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
