/**
 * POST /api/asset — upload one clip and get back the asset id Mirelo will
 * transcribe. The body is the WAV itself, `Content-Type: audio/wav`.
 *
 * The audio comes through this function rather than going straight to storage,
 * and that is deliberate. Mirelo's asset flow hands back a presigned S3 URL the
 * browser could PUT to directly — which is the right shape for large uploads,
 * and it is what this endpoint used to do. But the ten-second cap has to be
 * enforced somewhere the browser cannot reach around, and the only way to know
 * how long a clip is, is to look at it. Ten seconds of mono PCM is under a
 * megabyte, so the cost of looking is nothing.
 *
 * So: read the WAV, measure it from its own header, refuse it if it is too
 * long, and only then spend a slot and the bytes.
 */
import { ApiError, MAX_CLIP_SECONDS, json, mirelo, readBody, route, throttle, wavSeconds } from "./_mirelo.js";

/** Ten seconds of 16-bit PCM is ~880KB mono at 44.1k, ~1.9MB stereo at 48k.
 *  Eight leaves room for a high sample rate and nothing else. */
const MAX_BYTES = 8 * 1024 * 1024;

/** The clip is small, but it still has to reach Mirelo's storage from here.
 *  Sixty seconds is far more than that upload has ever needed and far less
 *  than the platform would otherwise allow it to sit for. */
export const config = { maxDuration: 60 };

export default route({
  POST: async (req, res) => {
    // The credit spend is POST /api/job, but this is the door it opens.
    // Six clips in ten minutes is more than a sitting; a loop is not.
    throttle(req, "asset", 6, 10 * 60_000);
    const audio = await readBody(req, MAX_BYTES);
    const seconds = wavSeconds(audio);

    // A hair of tolerance: a crop of exactly ten seconds can land a sample or
    // two over once it has been cut on a frame boundary.
    if (seconds > MAX_CLIP_SECONDS + 0.05) {
      throw new ApiError(
        413,
        `that clip is ${seconds.toFixed(1)}s — this app transcribes at most ${MAX_CLIP_SECONDS}s at a time`,
      );
    }
    if (seconds < 0.5) {
      throw new ApiError(400, "that clip is too short to transcribe");
    }

    const slot = await mirelo("/v2/assets", {
      method: "POST",
      body: { content_type: "audio/wav" },
    });

    // The presigned URL never leaves this function. It is a capability scoped
    // to one PUT, and there is no reason for the browser to hold one when the
    // bytes are already here.
    const upload = await fetch(slot.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(audio),
    });
    if (!upload.ok) {
      throw new ApiError(502, `storage refused the clip (${upload.status})`);
    }

    json(res, 200, { asset_id: slot.asset_id, seconds });
  },
});
