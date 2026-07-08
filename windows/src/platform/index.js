// Platform selector. This is the Windows edition of intelbyte, so it only ships
// the Windows adapter; running it elsewhere is a clear, early error. (The Linux
// edition is a separate build with its own adapter.)
import windows from './windows/index.js';

if (process.platform !== 'win32') {
  console.error(
    `intelbyte (Windows edition) can't run on "${process.platform}". ` +
      'Use the Linux edition on Linux.'
  );
  process.exit(1);
}

export default windows;
