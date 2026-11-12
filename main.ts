// photo-geolocator-01 entry: a vision-model geolocator with a deterministic code-only fallback.
//
// For each photo it asks claude-sonnet-5-5 (once) where the photo was taken, reading the latitude
// and longitude out of the answer. When a model call is refused (no API key pushed, budget spent)
// or an answer holds no coordinates, it falls back to a single fixed point -- the spherical
// geometric median of the kit's practice photos -- so no photo is left unanswered (an unanswered
// photo counts the maximum 20,015 km; the fixed point is far better than that).
//
// It runs as the grader runs an entry, `node /bot/main.ts` on Node 22 (erasable TypeScript, the
// standard library only), with the trial's variables: MAKEFUN_ENV_URL (the env),
// ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY (the gateway and the dummy key it swaps for the real
// one). The key is the entrant's own Anthropic key, pushed to the competition before submitting;
// the house pays for none of an entry's model calls. With no Anthropic key pushed every model
// call is answered 401 and every photo takes the fallback.
//
// Deterministic given the model's answers: every request is a function of the photo's bytes and
// the fixed prompt, the calls run four at a time and their answers are posted in photo order, so
// a replay sends the same calls and leaves the same answers. The fallback is a constant.

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1024;
const CONCURRENCY = 4;
const PROMPT = 'Where was this photo taken? Look for clues: road signs and their language and script, license plates, which side of the road vehicles drive on, vegetation and climate, architecture and building style, road markings and street furniture, any visible text. Give your best estimate of the latitude and longitude as one line of JSON: {"lat": <degrees north>, "lon": <degrees east>}.';
/** Fallback when the model cannot place a photo: the spherical geometric median of the kit's practice photos (central Brazil). Deterministic, and far better than leaving a photo unanswered (20,015 km). */
const FALLBACK_LAT = -15.267783;
const FALLBACK_LON = -48.667685;
/** Retried with a fixed backoff: a provider's transient errors. A gateway refusal (4xx) is final. */
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504, 529];
const RETRIES = 3;

interface Photo {
  id: string;
  url: string;
  answered: boolean;
}

interface Guess {
  id: string;
  lat: number;
  lon: number;
}

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}

const envUrl = need('MAKEFUN_ENV_URL').replace(/\/+$/, '');
const anthropicUrl = need('ANTHROPIC_BASE_URL').replace(/\/+$/, '');
const apiKey = need('ANTHROPIC_API_KEY');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The model's answer to one photo, as text; null when the gateway refused the call (final). */
async function ask(jpeg: Buffer): Promise<string | null> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${anthropicUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
    });
    if (res.ok) {
      const msg = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (msg.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
    }
    const text = await res.text();
    if (RETRY_STATUSES.includes(res.status) && res.headers.get('x-should-retry') !== 'false' && attempt < RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    process.stderr.write(`geolocator: the model call was refused (HTTP ${res.status}): ${text.slice(0, 300)}\n`);
    return null;
  }
}

const isLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isLon = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

/** The latitude and longitude an answer gives: its first JSON object with lat and lon, else its first two numbers in range. */
function coordinates(text: string): { lat: number; lon: number } | null {
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      const lat = o.lat ?? o.latitude;
      const lon = o.lon ?? o.lng ?? o.longitude;
      if (isLat(lat) && isLon(lon)) return { lat, lon };
    } catch {
      // Not JSON: the next one, or the numbers below.
    }
  }
  const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  for (let i = 0; i + 1 < nums.length; i += 1) {
    if (isLat(nums[i]) && isLon(nums[i + 1])) return { lat: nums[i]!, lon: nums[i + 1]! };
  }
  return null;
}

async function main(): Promise<number> {
  const listed = (await (await fetch(`${envUrl}/photos`)).json()) as { photos: Photo[] };
  const photos = listed.photos.filter((p) => !p.answered);
  const guesses: (Guess | null)[] = new Array(photos.length).fill(null);
  let refused = 0;
  let fallbackCount = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < photos.length) {
      const i = next;
      next += 1;
      const p = photos[i]!;
      const jpeg = Buffer.from(await (await fetch(`${envUrl}${p.url}`)).arrayBuffer());
      const text = await ask(jpeg);
      if (text === null) {
        refused += 1;
        guesses[i] = { id: p.id, lat: FALLBACK_LAT, lon: FALLBACK_LON };
        fallbackCount += 1;
        continue;
      }
      const c = coordinates(text);
      if (c === null) {
        process.stderr.write(`geolocator: no coordinates in the answer for ${p.id}: ${text.slice(0, 200)}\n`);
        guesses[i] = { id: p.id, lat: FALLBACK_LAT, lon: FALLBACK_LON };
        fallbackCount += 1;
      } else {
        guesses[i] = { id: p.id, lat: c.lat, lon: c.lon };
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const answers = guesses.filter((g): g is Guess => g !== null);
  process.stdout.write(`geolocator: ${answers.length} of ${photos.length} photos answered (${fallbackCount} by fallback, ${refused} model calls refused).\n`);
  if (answers.length === 0) return refused > 0 ? 1 : 0;
  const res = await fetch(`${envUrl}/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) });
  process.stdout.write(`geolocator: posted ${answers.length} answers: HTTP ${res.status} ${await res.text()}`);
  return res.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`geolocator: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
}
