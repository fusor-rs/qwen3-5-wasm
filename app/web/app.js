import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// worker and, in threaded builds, its compute workers (fusor-ai's ComputePool), and the media:
// images chosen, dropped or pasted are decoded here to RGBA pixels, and videos sampled to frames
// as the reference samples them (2 a second, 4 to 32 spread over the whole video), each drawn as
// a thumbnail, then handed to the engine worker with the message when Send is pressed. It
// measures each reply and reports back with `engine` events.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundle served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
const MODEL_URL = new URL(params.get('model') ?? 'model/', document.baseURI).href;
// The reference's sampling (the video processor's `fps`, `min_frames` and the runtime's
// `qwen3_5::media::MAX_FRAMES`).
const SAMPLES_PER_SECOND = 2;
const MIN_FRAMES = 4;
const MAX_FRAMES = 32;
// The frames a video's rate is measured over, and the rate assumed where it cannot be.
const RATE_FRAMES = 6;
const DEFAULT_RATE = 24;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const engine = new Worker(new URL('engine/worker.js', document.baseURI), { type: 'module', name: 'qwen3-5-engine' });
  const computePool = new ComputePool(crash);
  let build = null;
  let notice = '';
  let loaded = false;
  let broken = false;
  let jobs = 0;
  let job = null;
  // The next message's media, and every medium shown, by index, for its thumbnails.
  let media = [];
  const shown = new Map();
  let added = 0;
  let readyAt = Infinity;

  const handlers = {
    [SPAWN_COMPUTE]: (message) => computePool.spawn(message),
    runtime: (message) => (build = message),
    warning: ({ message }) => {
      console.warn(message);
      notice = ` (${message})`;
    },
    progress: ({ done, total, network, cache }) => {
      const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
      report({ type: 'loading', fraction: done / total, detail: `${mb(done)} / ${mb(total)} · ${source}` });
    },
    ready: ({ ms, cache, total }) => {
      loaded = true;
      readyAt = performance.now();
      const loadedInfo = { build: `${build.build}${notice}`, threads: build.threads, bundle_bytes: total, load_ms: ms, from_device: cache === total };
      report({ type: 'ready', loaded: loadedInfo });
    },
    started: (message) => {
      if (message.job !== job?.id) return;
      job.plan = message.plan;
      const { images, videos } = message.plan.media;
      const status = images.length + videos.length ? 'Looking at the images and videos…' : 'Reading the message…';
      report({ type: 'reply', status, reasoning: null, answer: '', metrics: metrics() });
    },
    reply: (message) => {
      if (message.job !== job?.id) return;
      reply(message, 'Writing…');
    },
    done: (message) => {
      if (message.job !== job?.id) return;
      if (!message.stopped) reply(message, 'Done.');
      report({ type: 'done', status: message.stopped ? 'Stopped.' : 'Done.', metrics: metrics(message) });
      job = null;
    },
    error: ({ message }) => {
      if (!loaded) return fail(message);
      job = null;
      report({ type: 'error', message });
    },
    fatal: ({ message }) => fail(message),
  };

  engine.onmessage = ({ data }) => {
    if (!broken) handlers[data.type]?.(data);
  };
  engine.onerror = (event) => crash(event.message || 'the engine worker failed');
  engine.postMessage({ type: 'load', modelUrl: MODEL_URL, threads: THREADS, build: params.get('build') });

  /** The reply so far, as the step left it. */
  function reply(message, writing) {
    const now = performance.now();
    if (message.tokens > 0) job.firstAt ??= now;
    job.lastAt = now;
    job.tokens = message.tokens;
    const status = message.stage === 'merge' ? 'Looking at the images and videos…' : writing;
    report({ type: 'reply', status, reasoning: message.reasoning, answer: message.answer, metrics: metrics(message) });
  }

  /** Decodes `files`, images to RGBA pixels as stored and videos to sampled frames, and adds them. */
  async function add(files) {
    if (job) return;
    for (const file of files) {
      try {
        const decoded = file.type.startsWith('video/') ? await sampleVideo(file) : await decodeImage(file);
        const medium = { index: added++, name: file.name || 'pasted image', ...decoded };
        media.push(medium);
        shown.set(medium.index, medium);
      } catch (error) {
        report({ type: 'error', message: `could not read ${file.name || 'the file'} (${error?.message ?? error})` });
      }
    }
    listMedia();
  }

  /** Replaces the media with the files at `paths` under /examples/. */
  async function attach() {
    clear();
    const paths = JSON.parse(inputs.attach.get());
    const files = await Promise.all(
      paths.map(async (path) => {
        const blob = await (await fetch(new URL(`examples/${path}`, document.baseURI))).blob();
        return new File([blob], path, { type: blob.type });
      }),
    );
    await add(files);
  }

  function listMedia() {
    const listed = media.map(({ index, name, width, height, frames }) => ({ index, name, width, height, frames: frames?.length }));
    report({ type: 'media', media: listed });
  }

  /** Draws each image or video's first frame into its thumbnails once the page has drawn the canvas for it. */
  function drawThumbnails() {
    for (const canvas of root.querySelectorAll('canvas[data-medium]')) {
      const medium = shown.get(Number(canvas.dataset.medium));
      if (!medium || canvas.dataset.drawn === canvas.dataset.medium) continue;
      canvas.dataset.drawn = canvas.dataset.medium;
      const scale = Math.min(1, (96 * devicePixelRatio) / medium.height);
      canvas.width = Math.round(medium.width * scale);
      canvas.height = Math.round(medium.height * scale);
      canvas.getContext('2d').drawImage(medium.bitmap, 0, 0, canvas.width, canvas.height);
    }
  }

  /** Sends the message `src/app.rs` composed, with the media, a seed of its own, and the turn's media leave the composer. */
  function send() {
    job = { id: ++jobs, t0: performance.now(), firstAt: null, lastAt: null, plan: null, tokens: 0 };
    const images = media.filter((medium) => !medium.times);
    const videos = media.filter((medium) => medium.times);
    const pictures = [...images.map((image) => image.rgba), ...videos.flatMap((video) => video.frames)];
    const rgba = new Uint8Array(pictures.reduce((sum, values) => sum + values.length, 0));
    let at = 0;
    for (const values of pictures) {
      rgba.set(values, at);
      at += values.length;
    }
    const layout = JSON.stringify({
      images: images.map(({ width, height }) => [width, height]),
      videos: videos.map(({ width, height, times }) => ({ width, height, times })),
    });
    const [seed] = crypto.getRandomValues(new Uint32Array(1));
    const message = JSON.stringify({ ...JSON.parse(inputs.message.get()), seed });
    media = [];
    engine.postMessage({ type: 'send', job: job.id, message, rgba, layout }, [rgba.buffer]);
  }

  function stop() {
    if (job) engine.postMessage({ type: 'stop', job: job.id });
  }

  function clear() {
    for (const medium of media) forget(medium);
    media = [];
    listMedia();
  }

  /** A new conversation: the engine forgets the last, and the page its media. */
  function reset() {
    for (const medium of shown.values()) if (!media.includes(medium)) forget(medium);
    engine.postMessage({ type: 'reset' });
  }

  function forget(medium) {
    medium.bitmap.close();
    shown.delete(medium.index);
  }

  function metrics(message = {}) {
    const ownRequests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;
    const tokens = job?.tokens ?? 0;
    return {
      first_ms: job?.firstAt ? job.firstAt - job.t0 : null,
      tokens,
      writing_ms: job?.firstAt ? job.lastAt - job.firstAt : 0,
      context_tokens: (job?.plan?.prompt_tokens ?? 0) + tokens,
      read_tokens: job?.plan?.read_tokens ?? 0,
      requests: ownRequests + (message.networkRequests ?? 0),
    };
  }

  /** The model could not load, or the engine or a compute thread died. */
  function fail(message) {
    broken = true;
    engine.terminate();
    computePool.terminate();
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  const file = root.querySelector('#file');
  const isMedia = (type) => type.startsWith('image/') || type.startsWith('video/');
  const onFile = () => {
    add([...file.files]);
    file.value = '';
  };
  const onDrop = (event) => {
    event.preventDefault();
    add([...(event.dataTransfer?.files ?? [])].filter((entry) => isMedia(entry.type)));
  };
  const onDragOver = (event) => event.preventDefault();
  const onPaste = (event) => {
    const items = [...(event.clipboardData?.items ?? [])].filter((entry) => isMedia(entry.type));
    if (items.length) add(items.map((item) => item.getAsFile()));
  };
  const thumbnails = new MutationObserver(drawThumbnails);
  thumbnails.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-medium'] });
  file.addEventListener('change', onFile);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragover', onDragOver);
  document.addEventListener('paste', onPaste);
  onCleanup(onClicks(inputs.sends, send));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(onClicks(inputs.clears, clear));
  onCleanup(onClicks(inputs.resets, reset));
  onCleanup(onClicks(inputs.attaches, attach));
  onCleanup(() => {
    file.removeEventListener('change', onFile);
    root.removeEventListener('drop', onDrop);
    root.removeEventListener('dragover', onDragOver);
    document.removeEventListener('paste', onPaste);
    thumbnails.disconnect();
    engine.terminate();
    computePool.terminate();
  });
}

/** An image's RGBA pixels as stored (no color conversion), and its bitmap. */
async function decodeImage(file) {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  return { width: bitmap.width, height: bitmap.height, rgba: pixels(bitmap, bitmap.width, bitmap.height), bitmap };
}

/** The RGBA pixels of `source` drawn at `width × height`. */
function pixels(source, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
}

/**
 * A video's frames as the reference samples them: of its `total` frames, `count` (2 a second,
 * 4 to 32) at `round(linspace(0, total - 1, count))`, each with its time, its index over the
 * frame rate.
 */
async function sampleVideo(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  try {
    await settled(video, 'loadeddata');
    const rate = await frameRate(video);
    const total = Math.max(1, Math.round(video.duration * rate));
    const count = Math.min(Math.max(Math.floor((total / rate) * SAMPLES_PER_SECOND), MIN_FRAMES), MAX_FRAMES, total);
    const indices = linspace(total - 1, count).map(roundHalfEven);
    const { videoWidth: width, videoHeight: height } = video;
    const frames = [];
    let bitmap = null;
    for (const index of indices) {
      video.currentTime = Math.min((index + 0.5) / rate, video.duration);
      await settled(video, 'seeked');
      frames.push(pixels(video, width, height));
      bitmap ??= await createImageBitmap(video);
    }
    return { width, height, frames, times: indices.map((index) => index / rate), bitmap };
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

/** The video's frame rate, from the shortest gap between frames presented while it plays. */
function frameRate(video) {
  return new Promise((resolve) => {
    if (!('requestVideoFrameCallback' in video)) return resolve(DEFAULT_RATE);
    const times = [];
    const onFrame = (_, { mediaTime }) => {
      times.push(mediaTime);
      if (times.length < RATE_FRAMES) return video.requestVideoFrameCallback(onFrame);
      video.pause();
      const gaps = times.slice(1).map((time, at) => time - times[at]).filter((gap) => gap > 0);
      resolve(gaps.length ? 1 / Math.min(...gaps) : DEFAULT_RATE);
    };
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => resolve(DEFAULT_RATE));
  });
}

/** NumPy's `linspace(0, last, count)`: each step's multiple, the last exactly `last`. */
function linspace(last, count) {
  const step = count > 1 ? last / (count - 1) : 0;
  return Array.from({ length: count }, (_, at) => (at === count - 1 ? last : at * step));
}

/** NumPy's `round`: halves to the even neighbour. */
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Resolves on the media element's next `event`, rejects on its error. */
function settled(element, event) {
  return new Promise((resolve, reject) => {
    element.addEventListener(event, resolve, { once: true });
    element.addEventListener('error', () => reject(new Error('the video could not be decoded')), { once: true });
  });
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
