import type { Track } from './album-player';
/** Parse only the user's selected file; audio never leaves this browser. */
export async function readLocalTrack(file: Blob, name: string): Promise<Track> {
  const track: Track = { file, title: name.replace(/\.[^.]+$/, '') };
  try {
    const { parseBlob, selectCover } = await import('./vendor/metadata/metadata.js');
    const metadata = await parseBlob(file, { duration: false, skipCovers: false });
    track.title = metadata.common.title || track.title;
    track.artist = metadata.common.artist;
    track.duration = metadata.format.duration;
    const picture = selectCover(metadata.common.picture);
    if (picture && picture.data.length <= 10 * 1048576 && /^image\/(jpeg|jpg|png|webp)$/i.test(picture.format)) {
      track.coverFile = new Blob([new Uint8Array(picture.data)], { type: picture.format === 'image/jpg' ? 'image/jpeg' : picture.format });
    }
  } catch { /* Missing or damaged tags must not prevent importing playable audio. */ }
  return track;
}
