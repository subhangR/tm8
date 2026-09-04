// Standalone real-app capture for the identity-display lane (NOT a spec —
// .mjs is outside the test glob). Follows capture-real-channel.mjs: creates a
// browser-local scratch account (localStorage in THIS Playwright profile only),
// then walks Settings → Your profile and a channel feed, screenshotting:
//   1. the empty-state profile editor (every field NULL — the normal state)
//   2. the globalId validation refusal
//   3. the saved profile (avatar + globalId) and its preview
//   4. a channel message author rendering the saved avatar
//   5. the members list self-row avatar
//   6. the broken-URL fallback (a 404 avatar collapses to the monogram)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = 'http://127.0.0.1:4612';
const OUT = 'gate-evidence/identity-profile';
mkdirSync(OUT, { recursive: true });

// Tiny deterministic avatar — a data: URL keeps the capture network-free and
// well under the schema's 2000-char cap.
const AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23b5651d'/%3E%3Ccircle cx='32' cy='24' r='12' fill='%23f4e3d0'/%3E%3Crect x='12' y='40' width='40' height='20' rx='10' fill='%23f4e3d0'/%3E%3C/svg%3E";

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1492, height: 812 } });
const page = await ctx.newPage();
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', `${OUT}/${name}.png`);
};

await page.goto(BASE);
await page.getByText(/create owner account/i).waitFor({ timeout: 15_000 });
await page.getByLabel(/your name/i).fill('Verify Capture');
await page.getByLabel(/password/i).fill(`scratch-${randomBytes(6).toString('hex')}`);
await page.getByRole('button', { name: /create owner account/i }).click();
await page.waitForTimeout(3500);
await shot('01-workspace-after-gate');

// → Settings via the rail.
await page.getByRole('button', { name: 'Settings' }).first().click();
await page.waitForTimeout(1200);
await shot('02-settings-members');

// → Your profile, empty state.
await page.getByRole('button', { name: 'Your profile' }).click();
await page.waitForTimeout(600);
await shot('03-your-profile-empty');

// Refused globalId.
await page.getByLabel('Global id').fill('not a global id');
await page.getByTestId('profile-save').click();
await page.getByTestId('profile-problem').waitFor({ timeout: 5_000 });
await shot('04-globalid-refused');

// Fill honestly and save.
await page.getByLabel('Display name').fill('Verify Human');
await page.getByLabel('Avatar URL').fill(AVATAR);
await page.getByLabel('Global id').fill('google:12345');
await page.getByTestId('profile-save').click();
await page.getByTestId('profile-saved').waitFor({ timeout: 10_000 });
await page.waitForTimeout(400);
await shot('05-profile-saved');

// Members: the self row should now carry the avatar.
await page.getByRole('button', { name: 'Members & roles' }).click();
await page.waitForTimeout(800);
await shot('06-members-self-avatar');

// The channel feed: the seeded message's author should render the avatar.
await page.getByText('general', { exact: true }).first().click().catch(() => {});
await page.waitForTimeout(2500);
await shot('07-channel-feed');

// Broken-URL fallback: preview a 404 avatar in the editor (no save) and watch
// it collapse to the monogram.
await page.getByRole('button', { name: 'Settings' }).first().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Your profile' }).click();
await page.waitForTimeout(600);
await page.getByLabel('Avatar URL').fill('http://127.0.0.1:4612/definitely-404.png');
await page.waitForTimeout(1500);
await shot('08-broken-avatar-fallback');

console.log('final url:', page.url());
await browser.close();
