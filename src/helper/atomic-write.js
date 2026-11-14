import { randomBytes } from 'crypto';
import { rename, unlink, writeFile } from 'fs/promises';

let counter = 0;

// Writes to a uniquely named temp file in the same folder, then renames over
// the target, so a reader never sees a half-written file and concurrent calls
// never share a temp file (pid + counter + random).
// options.mode sets the file permissions (for example 0o600 for token files).
export async function writeFileAtomic(path, content, options = {}) {
  counter += 1;
  const tmp = `${path}.${process.pid}.${counter}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: 'utf-8', ...(options.mode === undefined ? {} : { mode: options.mode }) });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
