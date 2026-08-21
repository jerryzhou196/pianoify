/**
 * GET /api/preflight?duration_ms=… — what a transcription of that much audio
 * will cost and roughly how long it will take.
 *
 * Only the duration is sent; the audio is not. The upload modal calls this as
 * the trim handles move, so the number under the Transcribe button is the cost
 * of the crop actually selected rather than of the whole file.
 */
import { MAX_CLIP_SECONDS, json, mirelo, query, route, throttle } from "./_mirelo.js";

/** The same cap the upload enforces — and, at ten minutes, the same one Mirelo
 *  enforces on this very endpoint. Sending it a duration it is going to refuse
 *  would turn a quote into an error message. */
const MAX_MS = MAX_CLIP_SECONDS * 1000;

export default route({
  GET: async (req, res) => {
    // Quotes are free at Mirelo, and the trim handles debounce to ~5/s at
    // worst. This is just so a tight loop cannot sit on the function.
    throttle(req, "preflight", 40, 60_000);
    const ms = Math.round(Number(query(req).get("duration_ms")));
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MS) {
      json(res, 400, {
        error: `duration_ms must be between 1 and ${MAX_MS} — mirelo transcribes at most ${MAX_CLIP_SECONDS / 60} minutes at a time`,
      });
      return;
    }
    const quote = await mirelo(`/v2/audio-to-midi/v1.0/preflight?duration_ms=${ms}`);
    json(res, 200, {
      credits: quote.credits ?? null,
      estimated_ms: quote.estimated_ms ?? null,
    });
  },
});
