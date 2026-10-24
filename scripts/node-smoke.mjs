// Runs a single-threaded wasm runtime build in Node against the bundle: pushes every part the way
// the browser loader does, then holds each conversation of fixtures/conversations.json turn by
// turn (its PNG images decoded here, a video read as the frames `just media` extracted), step by
// step as the page does, and prints each reply's speed, the facts it states and how much of the
// reference's reply (fixtures/references.json) it repeats. With `--out`, each conversation's
// replies are written to `<dir>/<conversation>.txt`.
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--media fixtures/media] [--out dir]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { inflateSync } from 'node:zlib';
import { agreement, missing, shown } from './agreement.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    media: { type: 'string', default: 'fixtures/media' },
    out: { type: 'string' },
  },
});
const CHUNK = 8 << 20;

const bundle = positionals[0] ?? 'dist/model';
const dist = new URL(`../app/engine/dist/${values.build}/`, import.meta.url);
const glue = await import(new URL('qwen3_5_runtime.js', dist));
glue.initSync({ module: readFileSync(new URL('qwen3_5_runtime_bg.wasm', dist)) });
const conversations = JSON.parse(readFileSync('fixtures/conversations.json', 'utf8'));
const references = JSON.parse(readFileSync('fixtures/references.json', 'utf8'));
if (values.out) mkdirSync(values.out, { recursive: true });
const runtime = load(bundle);
let failed = false;
for (const [name, { turns }] of Object.entries(conversations)) {
  runtime.reset();
  const replies = [];
  turns.forEach(({ images = [], videos = [], expect = [], ...message }, index) => {
    const { rgba, layout } = media(images, videos);
    const start = performance.now();
    const plan = JSON.parse(runtime.start(JSON.stringify(message), rgba, JSON.stringify(layout)));
    let progress = JSON.parse(runtime.step());
    let first = null;
    while (!progress.done) {
      first ??= progress.tokens ? performance.now() : null;
      progress = JSON.parse(runtime.step());
    }
    const seconds = (performance.now() - start) / 1000;
    const written = (performance.now() - (first ?? start)) / 1000;
    const reply = progress.reasoning === null ? progress.answer : `${progress.reasoning}\n${progress.answer}`;
    const left = missing(expect, progress.answer);
    const repeated = agreement(shown(references[name][index], message.thinking), reply);
    console.log(`  ${name} ${index}: ${plan.read_tokens} tokens read, ${progress.tokens} written in ${seconds.toFixed(2)}s (${((progress.tokens - 1) / written).toFixed(1)} tokens/s); ${left.length ? `missing ${left.join(', ')}` : `states ${expect.join(', ') || 'nothing asked'}`}; ${(repeated * 100).toFixed(0)}% of the reference's reply repeated`);
    console.log(`    ${JSON.stringify(progress.answer)}`);
    failed ||= left.length > 0;
    replies.push(reply);
  });
  if (values.out) writeFileSync(join(values.out, `${name}.txt`), `${replies.join('\n\n---\n\n')}\n`);
}
runtime.free();
if (failed) process.exit(1);

/** A runtime with every part of the bundle in `bundle` pushed into it. */
function load(bundle) {
  const t0 = performance.now();
  const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
  const runtime = new glue.Runtime(manifest);
  let ready = false;
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(bundle, part.file));
    for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
    ready = runtime.end_part(index);
  });
  if (!ready) throw new Error(`${bundle}: engine not ready after every part`);
  console.log(`${values.build} ${bundle}: load ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  return runtime;
}

/** A turn's images and videos as the runtime takes them: RGBA pixels and their layout. */
function media(images, videos) {
  const pictures = images.map((file) => readPng(readFileSync(join(values.media, file))));
  const clips = videos.map((file) => {
    const dir = join(values.media, `${file}.frames`);
    const times = JSON.parse(readFileSync(join(dir, 'times.json'), 'utf8'));
    const frames = times.map((_, index) => readPng(readFileSync(join(dir, `${String(index).padStart(3, '0')}.png`))));
    return { times, frames };
  });
  const all = [...pictures, ...clips.flatMap((clip) => clip.frames)];
  const rgba = new Uint8Array(all.reduce((sum, picture) => sum + picture.rgba.length, 0));
  let at = 0;
  for (const picture of all) {
    rgba.set(picture.rgba, at);
    at += picture.rgba.length;
  }
  const layout = {
    images: pictures.map(({ width, height }) => [width, height]),
    videos: clips.map(({ times, frames }) => ({ width: frames[0].width, height: frames[0].height, times })),
  };
  return { rgba, layout };
}

/** The pixels of an 8-bit, non-interlaced PNG (grey, grey and alpha, RGB or RGBA), as RGBA. */
function readPng(bytes) {
  const CHANNELS = { 0: 1, 4: 2, 2: 3, 6: 4 };
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let at = 8; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') {
      [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      if (body[8] !== 8 || body[12] !== 0 || !(body[9] in CHANNELS)) throw new Error('an 8-bit, non-interlaced PNG expected');
      channels = CHANNELS[body[9]];
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      pixels[y * stride + x] = (line[x] + predict(filter, left, up, corner)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const pixel = pixels.subarray(i * channels, (i + 1) * channels);
    const [r, g, b] = channels >= 3 ? pixel : [pixel[0], pixel[0], pixel[0]];
    rgba.set([r, g, b, channels % 2 === 0 ? pixel[channels - 1] : 255], i * 4);
  }
  return { width, height, rgba };
}

/** PNG's filter predictor of a byte from its left, upper and upper-left neighbours. */
function predict(filter, left, up, corner) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  const estimate = left + up - corner;
  const [toLeft, toUp, toCorner] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
  return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
}
