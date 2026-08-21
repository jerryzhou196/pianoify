/**
 * Pull one file out of a zip, in the browser, without a zip library.
 *
 * The GPU box's `/sheets` writes its archive with `ZIP_STORED` — no
 * compression — precisely so a client can unpack it like this: every member's
 * bytes sit verbatim in the archive, and getting one out is a matter of
 * finding where it starts. A deflate implementation would be a dependency an
 * order of magnitude larger than this file, for one member of one archive.
 *
 * Anything unexpected — a truncated download, a member that turns out to be
 * compressed after all — returns null rather than throwing. The caller treats
 * a missing file the same way it treats a failed request.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record is 22 bytes plus a comment of up to 64KB. */
const EOCD_MAX_SEARCH = 22 + 0xffff;

export function fileFromZip(archive: ArrayBuffer, name: string): Uint8Array<ArrayBuffer> | null {
  const view = new DataView(archive);
  const bytes = new Uint8Array(archive);

  // The end-of-central-directory record is last, but a trailing comment means
  // its position is not fixed — so it is found by scanning back for its
  // signature rather than by arithmetic.
  let eocd = -1;
  const floor = Math.max(0, archive.byteLength - EOCD_MAX_SEARCH);
  for (let i = archive.byteLength - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let entry = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (entry + 46 > archive.byteLength) return null;
    if (view.getUint32(entry, true) !== CENTRAL_SIGNATURE) return null;

    const method = view.getUint16(entry + 10, true);
    const size = view.getUint32(entry + 20, true);
    const nameLength = view.getUint16(entry + 28, true);
    const extraLength = view.getUint16(entry + 30, true);
    const commentLength = view.getUint16(entry + 32, true);
    const localAt = view.getUint32(entry + 42, true);
    const entryName = decoder.decode(bytes.subarray(entry + 46, entry + 46 + nameLength));

    if (entryName === name) {
      // Stored only. Anything else and we have no way to read it.
      if (method !== 0) return null;
      if (view.getUint32(localAt, true) !== LOCAL_SIGNATURE) return null;
      // The local header repeats the name and carries its own extra field,
      // which is usually a different length from the central one — so the data
      // offset has to come from here, not from the entry above.
      const localNameLength = view.getUint16(localAt + 26, true);
      const localExtraLength = view.getUint16(localAt + 28, true);
      const from = localAt + 30 + localNameLength + localExtraLength;
      if (from + size > archive.byteLength) return null;
      return bytes.subarray(from, from + size);
    }

    entry += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
