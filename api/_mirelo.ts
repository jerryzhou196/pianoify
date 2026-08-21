/**
 * The server half of the Mirelo client.
 *
 * It exists for one reason: `MIRELO_KEY` is a bearer token that bills a real
 * account, and a `VITE_*` variable is inlined into a JavaScript bundle anyone
 * can read. So the key never leaves the function, and the browser talks to
 * these three endpoints instead — which are deliberately thin, and forward
 * only the fields the app actually sets.
 *
 * The audio itself does *not* come through here. `/api/asset` hands the browser
 * a presigned S3 URL and the browser PUTs to it directly (the bucket answers
 * preflight with `Access-Control-Allow-Methods: PUT`), so a 30MB upload never
 * touches a function invocation. See `api/asset.ts`.
 *
 * Written against `node:http` types rather than `@vercel/node`, because the
 * same handlers are mounted by the Vite dev server (see `vite.config.ts`) and
 * that is the only signature both runtimes agree on.
 *
 * The endpoints import this file as `./_mirelo.js`, with the extension and
 * with the wrong one. That is not a typo: this package is `"type": "module"`,
 * so the compiled functions run as ESM under Node, where a relative import
 * without an extension does not resolve at all — the first deploy answered
 * every request with ERR_MODULE_NOT_FOUND. TypeScript and Vite both map the
 * `.js` back to this `.ts`; Node needs to see the file it will actually load.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const API = "https://api.mirelo.ai";

/** The one instrument this app has.
 *
 *  Mirelo treats `instruments` as an exhaustive list, not a filter: every name
 *  outside it is masked out of the model's vocabulary, so an instrument that is
 *  not listed cannot appear in the output at all. That is exactly what we want
 *  — the product is a *piano reduction* of whatever went in, and asking for one
 *  instrument is what turns a drum kit into left-hand chords instead of into
 *  the General MIDI drum map played as pitches. The docs warn that listing an
 *  instrument the audio does not contain makes the model split a real part in
 *  two; here that is the point, and the split is toward the piano. */
export const INSTRUMENTS = ["acoustic_piano"] as const;

/**
 * The longest clip this app will ever send, in seconds.
 *
 * A product decision enforced where it cannot be argued with. Mirelo bills 2.5
 * credits per second of input, and everything downstream of the transcription
 * — the roll, the pedal, the fingering — reads better on ten seconds of the
 * part worth hearing than on a whole track. The browser caps the trim handles
 * at the same number, but that is a courtesy; this is the cap.
 */
export const MAX_CLIP_SECONDS = 10;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function key(): string {
  const k = process.env.MIRELO_KEY;
  if (!k) {
    throw new ApiError(
      500,
      "MIRELO_KEY is not set on the server — add it to the project's environment variables",
    );
  }
  return k;
}

/** Call Mirelo and return its JSON, turning a failure into an `ApiError` whose
 *  message is Mirelo's own where it has one. A 400 from the transcriber ("that
 *  file is not decodable audio") says more than anything we could invent. */
export async function mirelo(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  const resp = await fetch(API + path, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await resp.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — a gateway error page, most likely. `detail` stays undefined
    // and the status carries the message instead.
  }
  if (!resp.ok) {
    const detail =
      (typeof body?.detail === "string" && body.detail) ||
      (typeof body?.message === "string" && body.message) ||
      (typeof body?.error === "string" && body.error) ||
      `mirelo returned ${resp.status}`;
    throw new ApiError(resp.status, detail);
  }
  return body;
}

/* ── request plumbing ────────────────────────────────────────────────────── */

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // These answers are per-request and per-key; nothing between here and the
  // browser should keep one.
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

/** Read and parse a JSON request body.
 *
 *  Vercel's Node runtime parses `application/json` into `req.body` before the
 *  handler runs and leaves the stream consumed; the Vite dev server does not.
 *  Checking for the parsed body first is what makes one handler work on both. */
export async function readJson(req: IncomingMessage): Promise<any> {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed && typeof parsed === "object") return parsed;
  if (typeof parsed === "string") return parsed ? JSON.parse(parsed) : {};

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Every body this API accepts is a few hundred bytes. The audio goes
    // straight to S3, so anything large here is a mistake or an attack.
    if (size > 64 * 1024) throw new ApiError(413, "request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "request body is not valid JSON");
  }
}

/** Read a raw request body, refusing anything past `limit` bytes.
 *
 *  Used for the one endpoint that carries audio. The ceiling is generous for
 *  ten seconds of mono PCM (about 880KB at 44.1k) and still small enough that
 *  a mistake cannot turn this into an upload service. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (Buffer.isBuffer(parsed)) return parsed;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new ApiError(413, "that clip is larger than this endpoint accepts");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * How long a 16-bit PCM WAV plays, from its header.
 *
 * This is the only place the clip's length can be *checked* rather than taken
 * on trust: a number the browser sends alongside the audio is a number the
 * browser can get wrong or lie about, and the whole point of the cap is that
 * it holds regardless. Walking the RIFF chunks is a dozen lines, and it also
 * rejects anything that is not actually a WAV before it costs a credit.
 */
export function wavSeconds(buf: Buffer): number {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new ApiError(400, "that upload is not a WAV file");
  }
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataBytes = 0;

  // Chunks are [4-byte id][4-byte size][payload], padded to even lengths.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      // A streamed WAV can carry a placeholder size; trust what actually
      // arrived when the declared size overruns the buffer.
      dataBytes = Math.min(size, buf.length - body);
      break;
    }
    at = body + size + (size % 2);
  }

  const bytesPerFrame = (channels * bits) / 8;
  if (!sampleRate || !bytesPerFrame || !dataBytes) {
    throw new ApiError(400, "that WAV has no readable format or data chunk");
  }
  return dataBytes / bytesPerFrame / sampleRate;
}

export function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://localhost").searchParams;
}

/**
 * Fixed-window counter, one bucket per (`name`, client IP), living in this
 * process.
 *
 * Enough to stop a curl loop from one machine. Not a distributed flood:
 * Vercel isolates do not share this Map, so N regions is N windows. The
 * billed endpoints are what this is for — a visitor who inspects `/api/job`
 * in the network tab still has to come through here, and here is no longer
 * unlimited.
 */
const windows = new Map<string, { n: number; reset: number }>();

function clientIp(req: IncomingMessage): string {
  // Prefer the header Vercel writes itself — a client-supplied X-Real-Ip
  // would otherwise be a new bucket on every request.
  const vercel = header(req, "x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0].trim();
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value ? value : undefined;
}

function sweep(now: number): void {
  for (const [key, slot] of windows) {
    if (now >= slot.reset) windows.delete(key);
  }
}

/** Throw 429 if this IP has already used `max` of this named bucket in the window. */
export function throttle(req: IncomingMessage, name: string, max: number, windowMs: number): void {
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;
  let slot = windows.get(key);
  if (!slot || now >= slot.reset) {
    slot = { n: 0, reset: now + windowMs };
    windows.set(key, slot);
  }
  slot.n++;
  if (slot.n > max) {
    const retry = Math.max(1, Math.ceil((slot.reset - now) / 1000));
    throw new ApiError(429, "too many requests from this address — wait a moment and try again", {
      "Retry-After": String(retry),
    });
  }
  if (windows.size > 2048) sweep(now);
}

/** Wrap a handler so every thrown `ApiError` becomes its status and message,
 *  and everything else becomes a 500 that says so without leaking a stack. */
export function route(
  methods: Record<string, Handler>,
): Handler {
  return async (req, res) => {
    const handler = methods[(req.method ?? "GET").toUpperCase()];
    if (!handler) {
      res.setHeader("Allow", Object.keys(methods).join(", "));
      json(res, 405, { error: `method ${req.method} not allowed here` });
      return;
    }
    try {
      await handler(req, res);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      const error = e instanceof Error ? e.message : "unknown server error";
      if (e instanceof ApiError) {
        for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
      }
      json(res, status, { error });
    }
  };
}
