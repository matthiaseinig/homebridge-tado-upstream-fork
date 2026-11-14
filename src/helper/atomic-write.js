import { rename, unlink, writeFile } from 'fs/promises';

// Writes to a temp file in the same folder, then renames over the target, so a
// reader never sees a half-written file.
export async function writeFileAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
