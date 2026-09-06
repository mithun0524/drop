// The native path. Inside the App Store / Play Store build there is no browser
// quota and no tab to be killed: incoming bytes go straight to the device
// filesystem, so size is bounded only by free space.
//
// Everything here is loaded on demand. The web build never pulls Capacitor in —
// isNative() is a synchronous check against a global the native shell injects,
// and the imports below only run once that has answered yes.

export const isNative = () =>
  typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

export const nativePlatform = () =>
  (typeof window !== 'undefined' && window.Capacitor?.getPlatform?.()) || 'web';

// One append per chunk would cross the JS/native bridge every 64KB. Batching to
// a few megabytes cuts that by a factor of sixty while still keeping only a few
// megabytes in memory at a time.
const FLUSH_AT = 4 * 1024 * 1024;

/**
 * ponytail: chunks cross the bridge as base64, which costs ~33% more bytes to
 * transfer and a copy to encode. A custom plugin taking raw bytes would avoid
 * both; worth writing if throughput on device turns out to be the limit rather
 * than the network.
 */
export function toBase64(bytes) {
  let s = '';
  // fromCharCode has an argument limit, so feed it in slices.
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

/** Where received files land, grouped so a day's transfers stay together. */
export const folderFor = (date = new Date()) =>
  'Drop/' + date.toISOString().slice(0, 10);

/**
 * A sink that appends straight to a file on the device. Returns nothing on
 * close because the file is already saved — there is no blob to hand back and
 * nothing to download.
 */
export async function nativeSink(name, folder = folderFor()) {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const path = `${folder}/${name}`;
  const directory = Directory.Documents;

  // Start clean: a resumed transfer reuses its own partial through the caller's
  // session, never a leftover from an earlier attempt at the same name.
  await Filesystem.deleteFile({ path, directory }).catch(() => {});
  await Filesystem.writeFile({ path, data: '', directory, recursive: true, encoding: Encoding.UTF8 });

  let buf = [];
  let held = 0;

  const flush = async () => {
    if (!held) return;
    const merged = new Uint8Array(held);
    let at = 0;
    for (const part of buf) {
      merged.set(part, at);
      at += part.length;
    }
    buf = [];
    held = 0;
    await Filesystem.appendFile({ path, data: toBase64(merged), directory });
  };

  return {
    write(chunk) {
      buf.push(chunk);
      held += chunk.length;
      if (held >= FLUSH_AT) return flush();
    },
    async close() {
      await flush();
      return null; // already on the filesystem
    },
    path,
  };
}

/** Hand the saved files to the OS, so they can go anywhere the user wants. */
export async function shareNative(paths, folder = folderFor()) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const uris = [];
  for (const name of paths) {
    const { uri } = await Filesystem.getUri({
      path: `${folder}/${name}`,
      directory: Directory.Documents,
    });
    uris.push(uri);
  }
  await Share.share({ files: uris, title: uris.length > 1 ? 'Received files' : 'Received file' });
}

/** Human-readable location, for telling someone where their files went. */
export const nativeLocation = (folder = folderFor()) =>
  nativePlatform() === 'ios' ? `Files › On My iPhone › Drop › ${folder.split('/')[1]}` : folder;
