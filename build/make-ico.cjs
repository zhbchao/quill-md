// Generates build/icon.ico (multi-size Windows icon) from build/icon.png.
// Usage: node build/make-ico.cjs   (requires macOS `sips` for resizing)
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const src = path.join(__dirname, 'icon.png');
const out = path.join(__dirname, 'icon.ico');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quill-ico-'));

const pngs = SIZES.map((size) => {
  const file = path.join(tmp, `icon-${size}.png`);
  execFileSync('sips', ['-z', String(size), String(size), src, '--out', file], {
    stdio: 'ignore',
  });
  return file;
});

pngToIco(pngs)
  .then((buf) => {
    fs.writeFileSync(out, buf);
    console.log('ICO_OK', out, `${buf.length} bytes, sizes: ${SIZES.join('/')}`);
  })
  .catch((err) => {
    console.error('ICO_FAIL', err);
    process.exit(1);
  });
