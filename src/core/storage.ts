import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

/** Replace a file only after its complete contents have been written beside it. */
export async function atomic(path: string, data: string | Uint8Array) {
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, path);
}
