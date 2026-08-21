import type { Hand, Note } from "./types";

/**
 * Who plays what, and with which finger.
 *
 * Mirelo transcribes pitch and time. It does not say which hand played a note
 * or which finger was on it — no audio-to-MIDI model can, because the
 * information is not in the sound. Both are inferred here, and both are
 * *readings* of the transcription rather than facts about the performance.
 *
 * They earn their place anyway: the roll's two colours are the difference
 * between a wall of rectangles and something you can see the shape of, and a
 * fingering is the difference between a piano roll and something you could sit
 * down and play from. Where the reading is wrong it is wrong the way a
 * sight-reader's first guess is wrong — plausible, and fixable by anyone who
 * can already read it.
 */

/** How far apart two onsets can be and still count as one grab of the keyboard.
 *  40ms is under the threshold where a rolled chord stops sounding like a
 *  chord, which is the same reason the engine voices simultaneities on the same
 *  window. */
const CHORD_WINDOW = 0.04;

/** How fast the split between the hands is allowed to move, per second of
 *  music. The split has to follow a left hand walking up the keyboard, but it
 *  must not chase a single melody note down into the bass and hand the whole
 *  next bar to the wrong colour. */
const SPLIT_DRIFT = 14;

/** Where the hands start, when the first cluster gives no reason to think
 *  otherwise. Middle C is the convention and the transcription usually
 *  disagrees with it within a bar. */
const HOME_SPLIT = 60;

/** Group notes that start together. The returned groups are in time order and
 *  each is sorted low to high, which is the order both passes want. */
function cluster(notes: Note[]): Note[][] {
  const out: Note[][] = [];
  for (let i = 0; i < notes.length; ) {
    let j = i;
    while (j < notes.length && notes[j].time - notes[i].time < CHORD_WINDOW) j++;
    out.push(notes.slice(i, j).sort((a, b) => a.midi - b.midi));
    i = j;
  }
  return out;
}

/**
 * Split the notes between the hands, in place.
 *
 * The split point is a line that moves through the piece rather than a fixed
 * pitch: a piece that lives above middle C for a page would otherwise be all
 * right hand, and a bass-register passage all left. Each cluster proposes a
 * split at its widest interior gap — which is where the two hands actually are
 * when a chord is voiced in both — and the line is allowed to move toward that
 * proposal at a bounded rate, so it tracks a walking bass but does not lunge at
 * one low melody note.
 *
 * A cluster with no gap worth calling one (a run of seconds, a single note)
 * proposes nothing and is simply cut by wherever the line currently is.
 */
export function assignHands(notes: Note[]): void {
  let split = HOME_SPLIT;
  let previous = notes.length ? notes[0].time : 0;

  for (const group of cluster(notes)) {
    const elapsed = Math.max(0, group[0].time - previous);
    previous = group[0].time;

    // The widest gap inside the cluster, if there is one worth using. Two
    // hands playing at once are almost always further apart than the notes
    // under either one of them; a fifth is the smallest gap that is more
    // likely to be the space between hands than a voicing inside one.
    let bestGap = 0;
    let proposal = split;
    for (let i = 1; i < group.length; i++) {
      const gap = group[i].midi - group[i - 1].midi;
      if (gap > bestGap) {
        bestGap = gap;
        proposal = (group[i].midi + group[i - 1].midi) / 2;
      }
    }
    // A cluster that sits entirely on one side of the line and spans less than
    // a hand can also *move* the line: it is a passage that has walked away
    // from where the split was, and following it is the whole point.
    if (bestGap < 7) {
      const span = group[group.length - 1].midi - group[0].midi;
      if (span <= 12) {
        const centre = (group[0].midi + group[group.length - 1].midi) / 2;
        proposal = centre < split ? centre + 7 : centre - 7;
      }
    }

    const limit = Math.max(1, SPLIT_DRIFT * elapsed);
    split += Math.max(-limit, Math.min(limit, proposal - split));
    split = Math.max(36, Math.min(84, split));

    for (const n of group) n.hand = n.midi < split ? "L" : "R";
  }
}

/**
 * Put a finger on every note.
 *
 * Two rules, which between them cover most of what a piano teacher would write
 * on a first pass. Within a chord, the fingers spread outward from the thumb:
 * the right hand takes 1 on its lowest note and counts up, the left hand takes
 * 1 on its highest and counts down, because the thumbs of the two hands face
 * each other. Between single notes, the hand *walks*: a step in either
 * direction moves one finger, a leap resets to a finger with room on both sides
 * of it, and the thumb is where the hand crosses when it runs out of fingers.
 *
 * `assignHands` must have run first — the walk is per hand, and a note with no
 * hand on it has no fingering to be part of.
 */
export function assignFingers(notes: Note[]): void {
  const last: Record<Hand, { midi: number; finger: number } | null> = { L: null, R: null };

  for (const group of cluster(notes)) {
    for (const hand of ["L", "R"] as const) {
      const inHand = group.filter((n) => n.hand === hand);
      if (!inHand.length) continue;

      if (inHand.length > 1) {
        // A grab: fingers spread from the thumb outward, and the outer note
        // takes 5 however many are in between — a four-note chord is 1-2-3-5,
        // not 1-2-3-4, which is what a hand actually does.
        const count = inHand.length;
        inHand.forEach((n, i) => {
          const fromThumb = hand === "R" ? i : count - 1 - i;
          n.finger = fromThumb >= count - 1 ? 5 : Math.min(5, fromThumb + 1);
        });
        const outer = hand === "R" ? inHand[inHand.length - 1] : inHand[0];
        last[hand] = { midi: outer.midi, finger: outer.finger };
        continue;
      }

      const n = inHand[0];
      const prev = last[hand];
      if (!prev) {
        n.finger = 3;
      } else {
        const step = n.midi - prev.midi;
        const up = hand === "R" ? step > 0 : step < 0;
        const size = Math.abs(step);
        if (size === 0) {
          // A repeated note: the same finger, unless it is the thumb, where
          // a pianist would usually change to keep the hand moving.
          n.finger = prev.finger;
        } else if (size <= 2) {
          n.finger = Math.max(1, Math.min(5, prev.finger + (up ? 1 : -1)));
          // Out of fingers going up, or out going down: the thumb crosses
          // under, or the hand comes back over it.
          if (prev.finger === 5 && up) n.finger = 1;
          if (prev.finger === 1 && !up) n.finger = 3;
        } else if (size <= 7) {
          n.finger = up ? Math.min(5, prev.finger + 2) : Math.max(1, prev.finger - 2);
        } else {
          // A leap: land on a finger with room to move either way afterwards.
          n.finger = 3;
        }
      }
      last[hand] = { midi: n.midi, finger: n.finger };
    }
  }
}
