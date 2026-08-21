/**
 * GET /api/fetch?url=… — pull a remote audio file through this origin.
 *
 * The upload modal needs the *bytes*, not just a link: the waveform, the trim
 * handles, and the "original" side of the crossfade all come from decoding the
 * audio in the tab, and most hosts do not answer a cross-origin fetch. So a
 * pasted link is fetched here and handed back same-origin, after which it is
 * the same File the drop zone would have produced and takes the same path.
 *
 * This is a proxy with an open `url`, so it is fenced: https only, no private
 * or loopback address, one redirect chain we follow ourselves so a redirect
 * cannot land somewhere the first check would have rejected, an audio content
 * type, and a hard byte ceiling.
 */
import { lookup } from "node:dns/promises";
import { ApiError, json, query, route, throttle } from "./_mirelo.js";

const MAX_BYTES = 60 * 1024 * 1024;
const MAX_REDIRECTS = 4;

/** Reject anything that resolves inside the network this function runs in.
 *  A URL is a user-supplied destination, and without this the endpoint is a
 *  window onto the platform's own metadata service and private services. */
async function assertPublic(target: URL): Promise<void> {
  if (target.protocol !== "https:") {
    throw new ApiError(400, "only https links can be fetched");
  }
  let addresses;
  try {
    addresses = await lookup(target.hostname, { all: true });
  } catch {
    throw new ApiError(400, `could not resolve ${target.hostname}`);
  }
  for (const { address, family } of addresses) {
    if (isPrivate(address, family)) {
      throw new ApiError(403, "that address is not publicly routable");
    }
  }
}

function isPrivate(address: string, family: number): boolean {
  if (family === 6) {
    const a = address.toLowerCase();
    if (a === "::1" || a === "::") return true;
    // Unique-local and link-local. IPv4-mapped addresses are re-checked as v4.
    if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8")) return true;
    if (a.startsWith("::ffff:")) return isPrivate(a.slice(7), 4);
    return false;
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Content types we will hand back. Plenty of static hosts serve audio as
 *  `application/octet-stream`, which the browser decodes just as happily. */
const ALLOWED = /^(audio\/|video\/mp4|application\/octet-stream)/i;

/** A slow host serving a large file is the normal case here, not the
 *  exceptional one. */
export const config = { maxDuration: 300 };

export default route({
  GET: async (req, res) => {
    // Not billed, but a 60MB proxy is still a bill — function time and
    // bandwidth. A few pastes a minute is the real use; a loop is not.
    throttle(req, "fetch", 8, 60_000);
    const raw = query(req).get("url") ?? "";
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      json(res, 400, { error: "url must be an absolute https link to an audio file" });
      return;
    }
    if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(target.hostname)) {
      // The client routes these to /ytdlp before they ever get here; a
      // YouTube link arriving at this endpoint is a bug or a hand-made
      // request, and either way this is not the thing that can serve it.
      json(res, 400, { error: "youtube links go to /ytdlp/download, not here" });
      return;
    }

    // Redirects are followed by hand so every hop is checked, not just the
    // first: `manual` means fetch hands back the 3xx rather than chasing it.
    let upstream: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublic(target);
      const resp = await fetch(target, { redirect: "manual", headers: { Accept: "audio/*,*/*" } });
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        void resp.body?.cancel();
        target = new URL(location, target);
        continue;
      }
      upstream = resp;
      break;
    }
    if (!upstream) {
      json(res, 502, { error: "that link redirects too many times" });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      json(res, 502, { error: `that link answered ${upstream.status}` });
      return;
    }

    const type = upstream.headers.get("content-type") ?? "application/octet-stream";
    if (!ALLOWED.test(type)) {
      void upstream.body.cancel();
      json(res, 415, { error: `that link is ${type.split(";")[0]}, not audio` });
      return;
    }
    const declared = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      void upstream.body.cancel();
      json(res, 413, { error: "that file is larger than 60MB" });
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    // The name the client will give the File. Falls back to the last path
    // segment, which is what a static host almost always calls it.
    res.setHeader(
      "X-Source-Name",
      encodeURIComponent(target.pathname.split("/").pop() || "audio"),
    );

    let sent = 0;
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sent += value.byteLength;
      if (sent > MAX_BYTES) {
        // Past the ceiling mid-stream (no content-length, or a lying one).
        // The response is already committed, so the only way to say so is to
        // stop writing and let the client's decode fail on a truncated file.
        void reader.cancel();
        break;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  },
});
