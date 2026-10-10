// Checks of what the page promises about itself (privacy, wording, forgetting), separate from the owner-loop checks in
// audit.spec.js and flow.spec.js. Runs against the offline API (fixtures, no Gemini key).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Runs in the page (added as an init script: the page's CSP does not allow eval, but an init script is not subject to it).
// It makes a JPEG in the browser and gives it a real EXIF block with GPS coordinates (26 deg 51' N, 80 deg 57' E), spliced
// in after the start marker. LAT and LON are the first two rationals of each coordinate (26/1, 51/1 and 80/1, 57/1) as
// bytes: a coordinate leaking into an upload would show up as exactly those bytes.
function installExifHelpers() {
  const LAT = [26, 0, 0, 0, 1, 0, 0, 0, 51, 0, 0, 0, 1, 0, 0, 0];
  const LON = [80, 0, 0, 0, 1, 0, 0, 0, 57, 0, 0, 0, 1, 0, 0, 0];
  const u16 = (v) => [v & 255, v >> 8];
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, count, value) => [...u16(tag), ...u16(type), ...u32(count), ...value];
  function gpsExifSegment() {
    const rational = (a, b, c) => [...u32(a), ...u32(1), ...u32(b), ...u32(1), ...u32(c), ...u32(1)];
    const gpsIfdAt = 26;
    const dataAt = gpsIfdAt + 2 + 4 * 12 + 4;
    const tiff = [
      0x49, 0x49, 0x2a, 0x00, ...u32(8),
      ...u16(1), ...entry(0x8825, 4, 1, u32(gpsIfdAt)), ...u32(0),
      ...u16(4),
      ...entry(0x0001, 2, 2, [0x4e, 0, 0, 0]), ...entry(0x0002, 5, 3, u32(dataAt)),
      ...entry(0x0003, 2, 2, [0x45, 0, 0, 0]), ...entry(0x0004, 5, 3, u32(dataAt + 24)),
      ...u32(0),
      ...rational(26, 51, 0), ...rational(80, 57, 0),
    ];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];  // "Exif", two zero bytes, then the TIFF structure
    return [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  }
  async function jpegWithGps(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#336699';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(width / 8, height / 8, width / 3, height / 4);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    const plain = new Uint8Array(await blob.arrayBuffer());
    return new Uint8Array([plain[0], plain[1], ...gpsExifSegment(), ...plain.slice(2)]);
  }
  // Every marker segment before the image data, named; an APP segment also by its first bytes (Exif, or the XMP namespace).
  function segments(bytes) {
    const out = [];
    let i = 2;
    while (i + 3 < bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      if (marker === 0xda) break;
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      const head = String.fromCharCode(...bytes.slice(i + 4, i + 10)).replace(/[^ -~]/g, '.');
      out.push(marker >= 0xe0 && marker <= 0xef ? `APP${marker - 0xe0}:${head}` : `M${marker.toString(16)}`);
      i += 2 + length;
    }
    return out;
  }
  function contains(bytes, pattern) {
    for (let i = 0; i + pattern.length <= bytes.length; i++) {
      let hit = true;
      for (let j = 0; j < pattern.length && hit; j++) hit = bytes[i + j] === pattern[j];
      if (hit) return true;
    }
    return false;
  }
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  // Everything that could carry a place or a person: EXIF and GPS data, XMP, a TIFF header.
  function leaks(bytes) {
    const found = [];
    if (segments(bytes).some((s) => s.startsWith('APP1'))) found.push('an APP1 segment (EXIF or XMP)');
    const patterns = [['the string Exif', ascii('Exif')], ['an XMP namespace', ascii('ns.adobe.com')], ['a little-endian TIFF header', [0x49, 0x49, 0x2a, 0]],
      ['a big-endian TIFF header', [0x4d, 0x4d, 0, 0x2a]], ['the GPS latitude bytes', LAT], ['the GPS longitude bytes', LON]];
    for (const [name, pattern] of patterns) if (contains(bytes, pattern)) found.push(name);
    return found;
  }
  window.__exif = { jpegWithGps, segments, leaks };
}

test('photos are re-encoded on the phone: the picture that leaves carries no EXIF, no GPS and no XMP, and is at most 1600 px', async ({ page }) => {
  await page.addInitScript(installExifHelpers);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const api = window.__exif;
    const out = {};
    for (const [name, w, h] of [['small', 64, 48], ['large', 3000, 2000]]) {
      const original = await api.jpegWithGps(w, h);
      const file = new File([original], `${name}.jpg`, { type: 'image/jpeg' });
      const b64 = await photoToJpegBase64(file);  // the page's own shrink-and-re-encode function
      const sent = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([sent], { type: 'image/jpeg' }));
      out[name] = {
        before: { segments: api.segments(original), leaks: api.leaks(original) },
        after: { segments: api.segments(sent), leaks: api.leaks(sent), starts: [sent[0], sent[1]], ends: [sent[sent.length - 2], sent[sent.length - 1]], width: bitmap.width, height: bitmap.height },
      };
    }
    return out;
  });

  for (const name of ['small', 'large']) {
    // The input really carries the EXIF block and the coordinates (so that the check below can fail)...
    expect(result[name].before.segments.some((s) => s.startsWith('APP1:Exif'))).toBe(true);
    expect(result[name].before.leaks).toEqual(expect.arrayContaining(['the string Exif', 'the GPS latitude bytes', 'the GPS longitude bytes']));
    // ...and nothing of it survives the page's re-encoding. What is left is a plain JPEG.
    expect(result[name].after.leaks, `${name}: what the re-encoded photo still carries`).toEqual([]);
    expect(result[name].after.segments.filter((s) => s.startsWith('APP1'))).toEqual([]);
    expect(result[name].after.starts).toEqual([0xff, 0xd8]);
    expect(result[name].after.ends).toEqual([0xff, 0xd9]);
  }
  expect([result.small.after.width, result.small.after.height]).toEqual([64, 48]);  // small photos are not enlarged
  expect(Math.max(result.large.after.width, result.large.after.height)).toBe(1600);  // large ones are shrunk
});

test('what the page uploads for a photo with GPS data is a re-encoded JPEG without it (checked on the request)', async ({ page, request }) => {
  const created = await request.post('/api/sites', { data: JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'synthetic_site.json'), 'utf-8')) });
  const id = (await created.json()).id;
  await page.addInitScript(installExifHelpers);
  await page.goto(`/?site=${id}#log`);
  await expect(page.locator('#panel-log')).toBeVisible();
  const uploads = [];
  await page.route('**/api/sites/*/extract', async (route) => {
    uploads.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidate: null, saved: false, confirm_required: true, synthetic: true, sample: true, heuristic: true }) });
  });
  // The owner picks a phone photo that carries GPS data (built in the browser, then handed to the file input).
  const original = Buffer.from(await page.evaluate(async () => btoa(String.fromCharCode(...(await window.__exif.jpegWithGps(800, 600))))), 'base64');
  await page.locator('#photo').setInputFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: original });
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0].mime_type).toBe('image/jpeg');
  const sent = Buffer.from(uploads[0].image_base64, 'base64');
  const LAT = Buffer.from([26, 0, 0, 0, 1, 0, 0, 0, 51, 0, 0, 0, 1, 0, 0, 0]);
  expect(original.includes('Exif')).toBe(true);
  expect(original.includes(LAT)).toBe(true);
  expect(sent.includes('Exif')).toBe(false);
  expect(sent.includes(LAT)).toBe(false);
  expect(sent.includes('ns.adobe.com')).toBe(false);
  expect(sent.subarray(0, 2).toString('hex')).toBe('ffd8');
  expect(sent.equals(original)).toBe(false);  // the bytes were produced again, not just trimmed
});
