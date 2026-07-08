// Tiny ANSI helpers — no dependencies.
// Monochrome (black & white) theme: the only variable is brightness —
// bold = bright white, normal = white, gray/dim = dark. No hues.
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const bold = wrap('1');
const plain = (s) => String(s);
const gray = wrap('90');

export const c = {
  bold,
  dim: wrap('2'),
  // Former accent colors all collapse to the mono palette.
  red: bold, // errors: bright
  green: bold, // success: bright
  yellow: bold, // warnings: bright
  blue: plain,
  magenta: bold, // section titles: bright
  cyan: plain, // commands: plain white (readable against gray descriptions)
  gray,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Animated banner: a bright-white highlight sweeps left→right across the art
// (on a dim base), then settles to solid bright white. Pure brightness, no hue —
// fits the black-&-white theme. Falls back to a static bright print when output
// isn't an interactive terminal (piped, NO_COLOR, dumb term).
const ESC = '\x1b[';
export async function animateBanner(lines) {
  const animate =
    process.stdout.isTTY && process.env.NO_COLOR === undefined && !/^(dumb)$/.test(process.env.TERM || '');
  if (!animate) {
    for (const l of lines) console.log(useColor ? bold(l) : l);
    return;
  }
  const H = lines.length;
  const W = Math.max(...lines.map((l) => l.length));
  // If the art is wider than the terminal it wraps, which breaks the cursor-up
  // frame math — print it statically instead.
  if (W >= (process.stdout.columns || 80)) {
    for (const l of lines) console.log(bold(l));
    return;
  }
  const band = 12;
  const step = 3;

  // Render one frame: chars inside the sweep band are bright (bold), the rest dim.
  const frame = (pos) => {
    let out = '';
    for (const l of lines) {
      let s = '';
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (ch === ' ') {
          s += ' ';
          continue;
        }
        const inBand = i <= pos && i > pos - band;
        s += `${ESC}${inBand ? '1' : '2'}m${ch}${ESC}0m`;
      }
      out += s + '\n';
    }
    return out;
  };

  process.stdout.write('\x1b[?25l'); // hide cursor during the sweep
  process.stdout.write(frame(-band)); // start: everything dim
  for (let pos = 0; pos <= W + band; pos += step) {
    process.stdout.write(`${ESC}${H}A\r`); // jump back to the top of the art
    process.stdout.write(frame(pos));
    await sleep(15);
  }
  process.stdout.write(`${ESC}${H}A\r`); // settle to solid bright white
  let fin = '';
  for (const l of lines) fin += `${ESC}1m${l}${ESC}0m\n`;
  process.stdout.write(fin);
  process.stdout.write('\x1b[?25h'); // show cursor again
}

export const ok = (s) => console.log(`${c.green('✔')} ${s}`);
export const info = (s) => console.log(`${c.cyan('ℹ')} ${s}`);
export const warn = (s) => console.log(`${c.yellow('⚠')} ${s}`);
export const err = (s) => console.error(`${c.red('✖')} ${s}`);
export const title = (s) => console.log(`\n${c.bold(c.magenta(s))}`);
export const line = (s = '') => console.log(s);

// Sleeker rounded "big" font (fits ~62 cols) + a small-screen fallback.
const BANNER = [
  '   ┬ ┌┐┌ ┌┬┐ ┌─┐ ┬   ┌┐ ┬ ┬ ┌┬┐ ┌─┐ ',
  '   │ │││  │  ├┤  │   ├┴┐└┬┘  │  ├┤  ',
  '   ┴ ┘└┘  ┴  └─┘ ┴─┘ └─┘ ┴   ┴  └─┘ ',
];
const BANNER_BIG = [
  '██╗███╗   ██╗████████╗███████╗██╗     ██████╗ ██╗   ██╗████████╗███████╗',
  '██║████╗  ██║╚══██╔══╝██╔════╝██║     ██╔══██╗╚██╗ ██╔╝╚══██╔══╝██╔════╝',
  '██║██╔██╗ ██║   ██║   █████╗  ██║     ██████╔╝ ╚████╔╝    ██║   █████╗  ',
  '██║██║╚██╗██║   ██║   ██╔══╝  ██║     ██╔══██╗  ╚██╔╝     ██║   ██╔══╝  ',
  '██║██║ ╚████║   ██║   ███████╗███████╗██████╔╝   ██║      ██║   ███████╗',
  '╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚══════╝╚═════╝    ╚═╝      ╚═╝   ╚══════╝',
];

export async function banner() {
  const cols = process.stdout.columns || 80;
  line('');
  const rows = cols >= 74 ? BANNER_BIG : BANNER;
  await animateBanner(rows);
  const tag = '🛡  screen-privacy shield · nothing leaks on stream';
  const pad = Math.max(0, Math.floor(((cols >= 74 ? 70 : 37) - tag.length) / 2));
  line(' '.repeat(pad) + c.gray(tag));
}
