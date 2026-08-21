/**
 * GET /api/preflight?duration_ms=… — what a transcription of that much audio
 * will cost and roughly how long it will take.
 *
 * Only the duration is sent; the audio is not. The upload modal calls this as
 * the trim handles move, so the number under the Transcribe button is the cost
 * of the crop actually selected rather than of the whole file.
 */
import { MAX_CLIP_SECONDS, json, mirelo, query, route } from "./_mirelo";

/** The same cap the upload enforces. Quoting a price for a clip that could
 *  never be sent would be quoting a lie. */
const MAX_MS = MAX_CLIP_SECONDS * 1000;

export default route({
  GET: async (req, res) => {
    const ms = Math.round(Number(query(req).get("duration_ms")));
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MS) {
      json(res, 400, {
        error: `duration_ms must be between 1 and ${MAX_MS} — this app transcribes at most ${MAX_CLIP_SECONDS}s at a time`,
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
