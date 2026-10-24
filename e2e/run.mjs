// End-to-end run in headless Chrome, in a fresh profile, of the page holding the fixed
// conversations, each reply greedy so that it can be held against the reference's.
//
// 1. Open the page, write the first message (text only) and press Send while the model is still
//    loading: it is replied to the moment the model is ready. Check each reply states the facts
//    its turn expects, report how much of the reference's reply it repeats, and check nothing was
//    requested after the model was ready.
// 2. Hold the rest of that conversation (its next turn thinks first), then a new one about an
//    image (`example-receipt.png`), then one about a video, which the page samples itself
//    (`example-video.webm`, the reference's MPEG-4 clip as Chrome decodes it), and check the
//    same.
// 3. Reload: the revisit must load every part from OPFS.
//
//   PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// Results (JSON, replies, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, log, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';
import { agreement, missing, shown } from '../scripts/agreement.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({});
const DEADLINE_MS = 30 * 60 * 1000;

const conversations = JSON.parse(readFileSync(join(ROOT, 'fixtures/conversations.json'), 'utf8'));
const references = JSON.parse(readFileSync(join(ROOT, 'fixtures/references.json'), 'utf8'));

// The page's state machine is `main[data-phase]`: idle, replying, broken.
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';

/** The last reply and the metric tiles, as the page shows them. */
async function readPage(page) {
  const tiles = ['first', 'speed', 'tokens', 'context', 'requests'];
  const shownTiles = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  const reply = page.locator('.message[data-role="model"]').last();
  const thought = reply.locator('.thought');
  return {
    answer: await reply.getAttribute('data-text'),
    reasoning: (await thought.count()) ? await thought.textContent() : null,
    status: await page.textContent('#status'),
    ...Object.fromEntries(tiles.map((id, i) => [id, shownTiles[i]])),
  };
}

/** Sets the page to reply as the fixture's turn asks: greedy, thinking or not, its longest reply. */
async function settle(page, { thinking = false, max_tokens: maxTokens, sampling }) {
  await page.locator('details.sampling').evaluate((details) => (details.open = true));
  await page.setChecked('#thinking', thinking);
  await page.setChecked('#card-sampling', false);
  await page.fill('#temperature', String(sampling.temperature));
  await page.fill('#top-p', String(sampling.top_p));
  await page.fill('#top-k', String(sampling.top_k));
  await page.fill('#presence-penalty', String(sampling.presence_penalty));
  await page.fill('#max-tokens', String(maxTokens));
}

/** Sends the turn (its images and videos, each video as its WebM); resolves once the reply is
 * written, with the requests made after the model was ready. */
async function say(page, turn, requestsSeen) {
  const { images = [], videos = [], text } = turn;
  const files = [...images, ...videos.map((video) => `${parse(video).name}.webm`)];
  if (files.length) {
    await page.setInputFiles('#file', files.map((file) => join(ROOT, 'fixtures/media', file)));
    await page.waitForFunction((count) => document.querySelectorAll('.composer canvas[data-medium]').length === count, files.length, { timeout: DEADLINE_MS });
  }
  await settle(page, turn);
  await page.fill('#message', text);
  const t0 = Date.now();
  await page.click('#send');
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  const mark = requestsSeen.length;
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  return { ...(await readPage(page)), wallMs: Date.now() - t0, fetched: fetched(requestsSeen, mark) };
}

function checkReply(check, name, index, said) {
  const turn = conversations[name].turns[index];
  const expected = turn.expect ?? [];
  const label = `${name} ${index}`;
  check(said.status === 'Done.', `${label}: ${said.tokens} tokens, the first in ${said.first}, then ${said.speed}; ${said.context} in context; ${(said.wallMs / 1000).toFixed(1)} s in all`);
  const left = missing(expected, said.answer);
  check(left.length === 0, `${label}: ${left.length ? `missing ${left.join(', ')}` : `states ${expected.join(', ')}`}: ${JSON.stringify(said.answer)}`);
  const reply = said.reasoning === null ? said.answer : `${said.reasoning}\n${said.answer}`;
  said.agreement = agreement(shown(references[name][index], turn.thinking), reply);
  log(`     ${label}: ${(said.agreement * 100).toFixed(0)}% of the reference's reply repeated`);
  check(said.fetched.length === 0 && said.requests === '0', `${label}: requests while replying: ${said.fetched.length} seen, page counts ${said.requests}`);
}

const launch = {
  root: ROOT,
  name: 'qwen3-5',
  values,
  fields: { cases: {} },
};
await run(launch, async ({ page, requests: requestsSeen, query, base, runDir, results, check, revisit }) => {
  await page.goto(`${base}/${query}`);
  await page.waitForSelector('main[data-phase]');
  results.sentWhileLoading = (await page.getAttribute('main', 'data-loaded')) !== 'true';
  log(`page open, the model ${results.sentWhileLoading ? 'still loading' : 'loaded'}`);
  for (const [name, { turns }] of Object.entries(conversations)) {
    if (await page.$('.message')) await page.click('#reset');
    const said = [];
    for (const [index, turn] of turns.entries()) {
      said.push(await say(page, turn, requestsSeen));
      results.runtime ??= await page.textContent('#runtime');
      checkReply(check, name, index, said[index]);
    }
    results.cases[name] = { first: said[0].first, speed: said.at(-1).speed, wallMs: said[0].wallMs, turns: said };
    const replies = said.map(({ reasoning, answer }) => (reasoning === null ? answer : `${reasoning}\n${answer}`));
    writeFileSync(join(runDir, `${STAMP}-${name}.txt`), `${replies.join('\n\n---\n\n')}\n`);
    await page.screenshot({ path: join(runDir, `${STAMP}-${name}.png`), fullPage: true });
  }

  await revisit(loadedOrBroken, DEADLINE_MS);
});
