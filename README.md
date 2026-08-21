# pianoify

Drop in a recording, hear it back as piano.

Drop a file or paste a YouTube link. It is decoded in the tab, drawn as a
waveform, and cropped by a window that opens ten seconds wide on the first
thing you actually played — drag its edges out and it takes as much as the
model will. That crop goes to one of two transcribers — [Mirelo](https://mirelo.ai)'s
audio-to-MIDI API, or a rented GPU box running
[MuScriptor](https://github.com/jerryzhou196/muscriptor), whichever the model
picker in the header names — conditioned on `acoustic_piano`, which sends back
the notes; the chords come from a CPU-only Hugging Face Space running BTC. The roll fills in while the
model is still decoding, plays on a sampled Steinway grand with a working damper
pedal, engraves the transcription's MusicXML on a second tab, and crossfades
against the original recording.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
```

`MIRELO_KEY` has to be in the environment the dev server starts in — it is
already in `~/.zshrc`, so a normal shell has it; a `.env.local` works too. The
key is only ever read by the functions in `api/`, which the dev server mounts
itself (see `vite.config.ts`), so `npm run dev` needs no `vercel dev` and no
tunnel.

## Deploying it

A static Vite build plus four Node functions. `vercel.json` has the rest.

1. Set **`MIRELO_KEY`** in the project's environment variables. Not `VITE_`
   prefixed — `VITE_*` is inlined into a bundle any visitor can read.
2. Optionally set `VITE_CHORD_API_BASE` (see `.env.example`). It is inlined at
   build time, so changing it takes a redeploy, not just a settings save.
3. Add the deployed origin to the chord Space's `ALLOWED_ORIGINS`, or the
   chord request fails at the preflight. The yt-dlp service and the GPU box
   need no such change — `vercel.json` rewrites `/ytdlp/*` and `/gpu/*` to
   them, so the browser only ever talks to this origin. That is what lets the
   GPU model work from a preview deployment, whose URL is different every time
   and could never be on an allowlist ahead of it.

## How it works

```
audio file, or a youtube link
   ↓  /ytdlp/download   (youtube only) the self-hosted yt-dlp service, reached
   ↓                    through this origin so no CORS allowlist is involved
   ↓  audio.ts          decode in the browser; peaks for the waveform; open the
   ↓                    trim handles on the first ten non-silent seconds
   ↓  (you drag)        move it, stretch it; the crop is cut to a mono 16-bit WAV
   ↓
   ├─ mirelo ─ POST /api/asset    → the WAV's header: measured, capped at 10
   │                                minutes, answered with a presigned URL
   │           PUT  (that URL)    → the audio itself, straight to Mirelo's
   │                                storage, no function in the way
   │           POST /api/job      → transcribes, conditioned on acoustic_piano
   │           GET  /api/job?id=… → polled: progress, and notes as decoded
   ├─ gpu ──── POST /gpu/transcribe
   │                              → rewritten to the box; answers with an SSE
   │                                stream of notes and, at the end, the MIDI
   │           POST /gpu/sheets   → the MIDI back for engraving, once the roll
   │                                is playing; a zip with the MusicXML in it
   └─ POST /analyze  (HF)  → chords, in parallel, from a different machine
   ↓
   ↓  hands.ts          split the notes between the hands; put a finger on each
   ↓  engine.ts         schedule them on a sampled Steinway piano
   ↓  Roll.tsx          draw them falling onto the keyboard, as they arrive
```

### Why the key needs a server

Mirelo's key is a bearer token against a billed account, and this is a static
site, so there is nowhere in the browser to put one. `api/` is four small
functions that hold it: measure a clip and open a slot, start a job, poll a
job, quote a price.

### How long a clip can be

Two different answers, because the two backends are two different bargains.

**Mirelo: ten minutes.** Not a number this app picked — its preflight refuses a
`duration_ms` past 600000, so ten minutes is the longest transcription the API
will quote or run. It still bills 2.5 credits per second, which makes a full
one 1500 credits, so the length of a clip is a number that costs money and a
cap the browser applies to itself is not a cap.

**The box: no limit.** It is rented by the hour, charges nothing per clip, and
transcribes in five-second chunks it streams as it decodes — so a long file
costs proportionally more time and no more memory. Ten minutes of piano comes
back in about six, with the first notes on the roll inside two seconds and the
rest arriving the whole way through.

### Measuring a clip without carrying it

The cap has to hold somewhere the browser cannot reach around, and for a while
that meant sending the audio through `/api/asset` so the function could look at
it. Ten seconds of mono PCM is under a megabyte, so the detour cost nothing.

Ten minutes is fifty megabytes, and a Vercel function refuses a request body
past 4.5MB — about fifty seconds of one. So the detour is over. The audio goes
from the tab straight to the presigned S3 URL Mirelo's asset flow hands out,
which is the shape it was designed for; the bucket answers a browser preflight
for PUT, so no function is in the way and nothing has to proxy fifty megabytes.

What comes to `/api/asset` instead is the WAV's *header* — a couple of hundred
bytes — and that turns out to be the whole measurement. A RIFF `data` chunk
declares how many sample bytes follow, and with the sample rate and frame size
from `fmt ` beside it that is the duration, exactly. It is not the browser's
summary of the clip, which could say anything; it is the file's own statement
of its length, and the decoder at the far end reads precisely that many bytes.
Appending more audio past a header that declares ten minutes does not buy an
eleventh — it produces a file every WAV reader stops ten minutes into. A
streamed WAV can leave a placeholder size there instead, which measures
nothing; those are refused rather than guessed at.

`src/config.ts` carries the same ten minutes so the trim handles never stretch
to a crop that would only be rejected — that copy is a courtesy, not the limit.

### Where the clip starts, and how long it runs

The window opens ten seconds wide, at the first thing you played.

Ten, out of a possible six hundred, because it is the length worth being wrong
about: a file dropped and transcribed without touching the waveform costs 25
credits rather than 1500, and the minutes are one drag away for whoever goes
looking for them. Both edges pull — the body of the window moves it, an edge
stretches it — and how far the edges go is the model's business rather than the
panel's, so switching the picker from the box to Mirelo pulls an over-long
window back to ten minutes instead of waiting to be refused at the button.

Where it opens is the older question, and the answer has not changed. Not the loudest window, and not the busiest one:
either is a guess about which part of a recording matters, and a guess that
lands in the middle of a track is one you have to check before you can trust
it. "Not silence" is measured against the file's own loud passages, since a
quiet piano recording and a mastered pop track disagree by 30dB about what
quiet means, and the window opens at the first run of frames above that floor
long enough to be a sound rather than a click. Everything else is a drag away.

### Why async, and why nothing is blocked

Transcription runs at roughly 1.5× realtime, so even a ten-second clip is
fifteen seconds of waiting — and a ten-minute one is a quarter of an hour. The
`/sync` endpoint would hold a function open for all of it, which past five
minutes is longer than the platform allows, and show nothing until it returned;
the async endpoint reports `progress_percent` and hands back the notes decoded
so far on every poll.

So the page does not wait. Notes are drawn as they land, the transport is live
the moment there are any, and the only thing on screen that says a
transcription is running is a strip in the corner of the roll with a cancel
button in it. Pressing play at 40% works, and the run finishing will not yank
the piece back to the start under you.

### YouTube

A YouTube link goes to a self-hosted yt-dlp service (FastAPI, `/ytdlp/` on
`jerryzhou.ca`), which copies YouTube's native AAC stream into an `.m4a`
without re-encoding. It is reached at a path on *this* origin — proxied by the
dev server, rewritten by `vercel.json` in production — so the browser makes no
cross-origin request and this app never has to appear in that service's CORS
allowlist. The service validates the YouTube host and the video id itself.

It is the slow part of the app: a download runs at roughly half the video's own
length and reports no progress until it is done, which is why the modal counts
the seconds out loud while it waits. Anything that is not a YouTube link goes
to `/api/fetch` instead — a fenced proxy: https only, no private address, an
audio content type, a size ceiling, and every redirect hop re-checked.

### Asking for piano

`instruments` is an exhaustive list, not a filter: Mirelo masks every
instrument outside it out of the model's vocabulary, so one that is not listed
cannot appear in the output at all. The docs warn that naming an instrument the
audio does not contain makes the model split a real part across two — here that
is exactly the point, and the split is toward the piano. Asking for
`acoustic_piano` is what turns a drum kit into left-hand chords instead of into
the General MIDI drum map played as pitches.

`timing` is Mirelo's other knob. `performance` keeps the take as played;
`quantized` snaps onsets to the detected beats and is honoured only when that
grid is steady enough to move notes onto — the sheet-music caption reports what
was actually applied, and why, when the two differ.

### The model picker

Three entries, two backends, in `src/models.ts`, in the order they are offered:

| | |
|---|---|
| **MuScriptor · GPU box** | the rented GPU, reached at `/gpu/*` — the default, and the one with no length limit |
| **Mirelo v1.0 · performance** | the hosted API, times as played, ten minutes at a time |
| **Mirelo v1.0 · quantized** | the same, onsets snapped to the detected beats |

`maxSeconds` on each entry is what the trim handles stop at, which is why the
cap lives in the model list rather than in the panel that draws them.

The picker is in two places (`ModelPicker.tsx`, one component and one piece of
state above it): the header, and the head of the upload modal. The modal's copy
is the one that matters — the modal cannot be dismissed, so until something has
been transcribed the header is behind the scrim, and the choice of what does
the transcribing has to be reachable before the file is, not after.

The box leads the list and is what the picker opens on, because it costs
nothing per clip.

Mirelo bills credits per second of input, which is why the modal quotes a price
before the button, and engraves as it transcribes: its MusicXML comes back with
the notes. The box costs nothing per clip because the instance is rented by the
hour, and streams its notes over SSE instead of being polled — they land on the
roll a few hundred milliseconds after it decodes them. Everything downstream —
hands, fingering, pedal, chords, sheet music, exports — is the same code either
way, because both clients return the same `Transcription`.

### Sheet music from the box

The box engraves too, but not in the same breath as the notes. `/sheets` runs
MuseScore over a MIDI file, which is a real layout program doing a real layout
on the box's CPU rather than its GPU: three or four seconds, against a
transcription that streams its first notes in under one. So it is a second
request, made once the notes are in and the roll is already playing, and the
sheet-music tab opens on a line saying so rather than staying shut. Nothing
waits for it — not the roll, not playback, not the MIDI export.

What gets sent back for engraving is the *quantized* copy of the transcription
where the box wrote one. Bar lines and note values come out of a beat grid, and
a performance a few milliseconds off one engraves into a page of tied
thirty-seconds that is technically the truth and useless to read. The roll
still shows the notes as played, so on those clips the two panels are showing
the same music at deliberately different times — which the sheet-music caption
says out loud. Without a steady enough grid the box writes no such copy, and
the performance MIDI is engraved instead, jitter and all.

`/sheets` answers with a zip — the MusicXML, the MIDI back again, and PDFs of
the score and the part — because MuseScore is slow enough that a round trip per
file would be worse. Only the MusicXML is taken out of it, by `src/zip.ts`, and
OpenSheetMusicDisplay draws it in the browser: a PDF would be a fixed page
width, and this one lays out at the reader's. The archive is written
uncompressed precisely so that unpacking one member of it is fifty lines rather
than a deflate implementation.

An engraving that fails costs the sheet-music tab and nothing else. The notes
are already on the roll and playing, the MIDI export still works, and the tab
says the box could not engrave that one.

The box answers a browser only from the origins in its
`MUSCRIPTOR_ALLOWED_ORIGINS`, so the app never calls it cross-origin: `/gpu/*`
is a rewrite in `vercel.json` and a proxy in `vite.config.ts`, which makes
every call same-origin to the browser and server-to-server to the box. Point
`VITE_MUSCRIPTOR_API_BASE` at the box's hostname to skip the hop, from an
origin it lists.

### The piano

`engine.ts` plays real Steinway recordings from the public-domain
[Splendid Grand Piano](https://github.com/sfzinstruments/SplendidGrandPiano)
set through [`smplr`](https://github.com/danigb/smplr). It loads thirteen
pitches at two touch levels while the upload panel is open, then transposes the
nearest recording by no more than four semitones to cover the keyboard. That
keeps the initial sample transfer to a few megabytes instead of shipping the
full 256 MB library.

Each key gets a 420 ms release after the transcription says it came up. That is
enough sustain for one note to hand naturally into the next, but short enough
that a new chord does not inherit the whole previous harmony. Playback waits
for every selected sample to decode, so a cold cache delays the first play
rather than silently dropping its opening notes.

### Hands and fingering

Invented, on purpose, and marked as such in `src/hands.ts`. No audio-to-MIDI
model can say which hand played a note, because the information is not in the
sound. The split is a line that moves through the piece — each simultaneity
proposes a split at its widest interior gap, and the line follows at a bounded
rate, so it tracks a walking bass without lunging at one low melody note. The
fingering is two rules: fingers spread from the thumb outward inside a chord,
and the hand walks a finger per step between single notes, crossing on the
thumb when it runs out. Both are readings of the transcription, not facts about
a performance — but they are the difference between a wall of rectangles and
something you can see the shape of.

### Speed

The transport's speed control stretches the piece onto the clock in one place
(`clockTime`). The sampled piano triggers each written note independently, so
it stays in tune at 0.5×; the original recording is *resampled*, so it drops an
octave the way a slowed tape does. That is the honest trade for a control whose
job is to let you follow a fast passage, and it is why the crossfade usually
wants to be on the transcribed side when the speed is not 1.

### Chords

From the Space, or not at all — Mirelo transcribes notes, not harmony. They
show up as dashed rules across the roll labelled with the symbol (click one to
jump there), and as the current symbol in the transport. A sleeping chord
service never turns a good transcription into an error.

### Being found

One page, client-rendered, which is the hardest shape to get indexed: until
Googlebot comes back for its second, JavaScript-running pass, `#root` is an
empty div and there is nothing on the page to rank. So `index.html` carries a
real paragraph inside `#root` — the app's own sentences, which React clears on
its first render — plus the title, description, canonical, Open Graph card and
a `WebApplication` block of JSON-LD.

`public/og.png` is the unfurl card, generated by hand from `tools/og-card.html`
(the command is at the top of that file) so its type is the app's own rather
than a drawing's approximation of it. `public/robots.txt` and
`public/sitemap.xml` name the canonical host, which is what stops the apex, the
`www` and a different preview hostname per deploy from competing for it.

## Layout

| | |
|---|---|
| `api/` | the four functions that hold `MIRELO_KEY` |
| `src/audio.ts` | decode, waveform, window selection, WAV encoding |
| `src/models.ts` | the model picker's entries, and what both transcribers speak |
| `src/mirelo.ts` | measure, upload, submit, poll, and what Mirelo's shapes mean |
| `src/muscriptor.ts` | the GPU box: one POST, the SSE stream it answers with, and the engraving that follows |
| `src/zip.ts` | one member out of a stored zip, so the engraving needs no zip library |
| `src/chords.ts` | the chord service |
| `src/links.ts` | pasted links: YouTube, and everything else |
| `src/hands.ts` | hand splitting and fingering |
| `src/engine.ts` | sampled-piano playback, crossfade, and transport |
| `src/roll.ts` | keyboard geometry and note colour |
| `src/App.tsx` | state, the animation loop, the layout |
| `src/styles.css` | the design, translated from the Claude Design project |
| `tools/og-card.html` | the source of the social card in `public/og.png` |

`src/styles.css` is the design system for this app, and its values come from
the Claude Design project it was drawn in (`Pianoify.dc.html`, project
`cab42753`). Retune it there and re-copy rather than diverging here, so the
running app and the design canvas do not drift.
