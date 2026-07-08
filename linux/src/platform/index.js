// Platform selector. This is the Linux edition of intelbyte, so it only ships
// the Linux adapter; running it elsewhere is a clear, early error rather than a
// confusing failure deep in app discovery. (The Windows edition is a separate
// build with its own adapter.)
import linux from './linux/index.js';

if (process.platform !== 'linux') {
  console.error(
    `intelbyte (Linux edition) can't run on "${process.platform}". ` +
      'Use the Windows edition on Windows.'
  );
  process.exit(1);
}

export default linux;
