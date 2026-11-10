import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  visibleRegion, sampleMedia, stripPixels, mainColors, pickColors, ensureContrast, contrastRatio, shownAverage, veilBackground, DEFAULT_VEIL,
  paletteColors, toHsl, fromHsl, turnHue
} from '../../src/visualizer/palette.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// A sample whose rows are given colors, top to bottom, each row band equally tall
function bandedSample(width, height, bands) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const color = bands[Math.floor(y * bands.length / height)];
    for (let x = 0; x < width; x++) pixels.set(color, (y * width + x) * 3);
  }
  return { width, height, pixels, dim: 0 };
}

const instance = (pipe, palette = {}) => ({ name: 'main', pipe, palette: { source: 'wallpaper', pick: 'vivid', minContrast: 3, ...palette } });

describe('visualizer palette', () => {
  describe('turnHue', () => {
    it('turns each color around the wheel, keeping grays, black, alpha and a full turn as they were', () => {
      expect(turnHue({ fg: '#000000ff', fg2: '#33aaccff' }, 180)).to.deep.equal({ fg: '#000000ff', fg2: '#cc5533ff' });
      expect(turnHue({ fg: '#33aacc' }, 120)).to.deep.equal({ fg: '#cc33aa' });
      expect(turnHue({ fg: '#33aacc80' }, 360)).to.deep.equal({ fg: '#33aacc80' });
      expect(turnHue({ fg: '#33aacc' }, -240)).to.deep.equal({ fg: '#cc33aa' });
      expect(turnHue({ fg: '#808080' }, 90)).to.deep.equal({ fg: '#808080' });
    });
  });

  describe('visibleRegion', () => {
    it('crops what overflows the monitor, centered, as mpv does with --panscan=1.0', () => {
      // 4:3 on 16:9: full width, middle rows
      expect(visibleRegion({ width: 4000, height: 3000 }, { width: 1920, height: 1080 })).to.deep.equal({ x: 0, y: 375, width: 4000, height: 2250 });
      // Portrait on landscape: full width, a middle band
      expect(visibleRegion({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).to.deep.equal({ x: 0, y: 656, width: 1080, height: 607 });
      // Ultra-wide on 16:9: full height, middle columns
      expect(visibleRegion({ width: 3440, height: 1440 }, { width: 1920, height: 1080 })).to.deep.equal({ x: 440, y: 0, width: 2560, height: 1440 });
    });
  });

  describe('sampleMedia', () => {
    it('decodes the visible region scaled down, seeking into videos, at low priority', async () => {
      const calls = [];
      const exec = async (file, args) => { calls.push([file, ...args]); return Buffer.alloc(96 * 54 * 3); };
      const monitor = { width: 1920, height: 1080 };
      const sample = await sampleMedia({ kind: 'video', path: '/m/a.mp4', width: 3840, height: 2160, duration: 1, dim: 30 }, monitor, { exec });
      expect(sample).to.include({ width: 96, height: 54, dim: 30 });
      expect(calls[0].slice(0, 4)).to.deep.equal(['nice', '-n', '19', 'ffmpeg']);
      expect(calls[0]).to.include.members(['-ss', '0.5', '/m/a.mp4', 'crop=3840:2160:0:0,scale=96:54', 'rgb24']);

      await sampleMedia({ kind: 'image', path: '/m/b.jpg', width: 4000, height: 3000 }, monitor, { exec });
      expect(calls[1]).to.not.include('-ss');
      expect(calls[1]).to.include('crop=4000:2250:0:375,scale=96:54');
    });

    it('rejects a short decode', async () => {
      const exec = async () => Buffer.alloc(10);
      const error = await sampleMedia({ kind: 'image', path: '/x', width: 100, height: 100 }, { width: 100, height: 100 }, { exec }).catch(caught => caught);
      expect(error.message).to.include('ffmpeg returned 10 bytes');
    });

    (hasFfmpeg ? it : it.skip)('samples a real image with ffmpeg', async function () {
      // Two real ffmpeg runs, slow on a loaded machine
      this.timeout(15000);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-palette-'));
      try {
        const file = path.join(dir, 'split.png');
        // Top half red, bottom half blue
        execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=320x180', '-f', 'lavfi', '-i', 'color=blue:s=320x180',
          '-filter_complex', 'vstack', '-frames:v', '1', file]);
        const monitor = { x: 0, y: 0, width: 640, height: 360 };
        const sample = await sampleMedia({ kind: 'image', path: file, width: 320, height: 360 }, monitor);
        const bottom = stripPixels(sample, monitor, { x: 0, y: 270, width: 640, height: 90 });
        const [main] = mainColors(bottom);
        expect(main.color[2]).to.be.above(200);
        expect(main.color[0]).to.be.below(40);
      } finally {
        await fs.remove(dir);
      }
    });
  });

  describe('stripPixels', () => {
    it('takes the sample under a window, in root coordinates on an offset monitor', () => {
      const sample = bandedSample(8, 4, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]);
      const monitor = { x: 1920, y: 0, width: 800, height: 400 };
      const bottom = stripPixels(sample, monitor, { x: 1920, y: 300, width: 800, height: 100 });
      expect(bottom).to.have.length(8);
      expect(bottom.every(pixel => pixel.join() === '255,255,0')).to.equal(true);
      // A window smaller than one sample pixel still gets one
      expect(stripPixels(sample, monitor, { x: 1920, y: 0, width: 10, height: 10 })).to.deep.equal([[255, 0, 0]]);
    });
  });

  describe('mainColors and pickColors', () => {
    const pixels = [
      ...Array(70).fill([20, 20, 30]), // dark background
      ...Array(20).fill([220, 40, 40]), // red subject
      ...Array(10).fill([200, 200, 200]) // grey highlight
    ];

    it('finds the main colors with their shares, largest first, the same way every time', () => {
      const clusters = mainColors(pixels, 3);
      expect(clusters.map(cluster => [cluster.color, cluster.share])).to.deep.equal([
        [[20, 20, 30], 0.7], [[220, 40, 40], 0.2], [[200, 200, 200], 0.1]
      ]);
      expect(mainColors(pixels, 3)).to.deep.equal(clusters);
      expect(mainColors([])).to.deep.equal([]);
    });

    it('picks by rule: vivid, dominant or complement', () => {
      const clusters = mainColors(pixels, 3);
      expect(pickColors(clusters, 'vivid', 1)).to.deep.equal([[220, 40, 40]]);
      expect(pickColors(clusters, 'dominant', 2)).to.deep.equal([[20, 20, 30], [220, 40, 40]]);
      const [complement] = pickColors(clusters, 'complement', 1);
      expect(Math.round(toHsl(complement)[0])).to.equal(180);
    });

    it('discounts specks for vivid and fills in a second color when there is only one', () => {
      const speck = [...Array(99).fill([100, 100, 100]), [255, 0, 0]];
      expect(pickColors(mainColors(speck, 2), 'vivid', 1)).to.deep.equal([[100, 100, 100]]);
      const [first, second] = pickColors(mainColors(Array(10).fill([40, 80, 160]), 2), 'vivid', 2);
      expect(first).to.deep.equal([40, 80, 160]);
      expect(toHsl(second)[2]).to.be.above(toHsl(first)[2]);
    });
  });

  describe('contrast', () => {
    it('lightens or darkens, keeping the hue, until the ratio is met, whichever changes less', () => {
      const darkBackground = [30, 30, 40];
      const dimRed = [90, 20, 20];
      const lifted = ensureContrast(dimRed, darkBackground, 3);
      expect(contrastRatio(lifted, darkBackground)).to.be.at.least(3);
      expect(Math.round(toHsl(lifted)[0])).to.equal(Math.round(toHsl(dimRed)[0]));
      expect(toHsl(lifted)[2]).to.be.above(toHsl(dimRed)[2]);

      const lightBackground = [230, 230, 220];
      const paleBlue = [170, 190, 230];
      const deepened = ensureContrast(paleBlue, lightBackground, 3);
      expect(contrastRatio(deepened, lightBackground)).to.be.at.least(3);
      expect(toHsl(deepened)[2]).to.be.below(toHsl(paleBlue)[2]);

      // On a mid-tone strip the near-black way out loses to a lighter color, even when it is the smaller change
      const midBackground = [104, 94, 32];
      const olive = ensureContrast([60, 55, 20], midBackground, 3);
      expect(contrastRatio(olive, midBackground)).to.be.at.least(3);
      expect(toHsl(olive)[2]).to.be.above(0.4);

      // A near-black with a faint tint stays near grey when lifted, not a strong color
      const tinted = ensureContrast([0, 6, 0], [7, 9, 7], 3);
      expect(contrastRatio(tinted, [7, 9, 7])).to.be.at.least(3);
      expect(Math.max(...tinted) - Math.min(...tinted)).to.be.below(30);

      // Already enough: unchanged; impossible: the extreme with the most contrast
      expect(ensureContrast([255, 255, 255], [0, 0, 0], 3)).to.deep.equal([255, 255, 255]);
      expect(contrastRatio(ensureContrast([128, 128, 128], [128, 128, 128], 21), [128, 128, 128])).to.be.above(4);
    });

    it('measures the background as shown, after the dim', () => {
      expect(shownAverage([[100, 100, 100], [200, 200, 200]])).to.deep.equal([150, 150, 150]);
      // A dim scales, as mpv's contrast does, so a color keeps its hue and dark ones stay above black
      expect(shownAverage([[100, 100, 100], [200, 200, 200]], 40)).to.deep.equal([90, 90, 90]);
      expect(shownAverage([[10, 20, 40]], 50)).to.deep.equal([5, 10, 20]);
      expect(shownAverage([[10, 10, 10]], 100)).to.deep.equal([0, 0, 0]);
    });

    it('round-trips HSL', () => {
      for (const color of [[220, 40, 40], [20, 200, 90], [128, 128, 128], [0, 0, 0]]) expect(fromHsl(toHsl(color))).to.deep.equal(color);
    });
  });

  describe('paletteColors', () => {
    const monitor = { x: 0, y: 0, width: 800, height: 400 };
    const geometry = { x: 0, y: 300, width: 800, height: 100 };

    it('gives each piped value a color from the strip under the window, keeping the configured alpha', () => {
      // Sky above, dark sea with an orange boat in the strip under the visualizer
      const sample = bandedSample(8, 8, [[120, 170, 230], [120, 170, 230], [120, 170, 230], [120, 170, 230], [120, 170, 230], [120, 170, 230], [10, 30, 60], [230, 120, 20]]);
      const colors = paletteColors(sample, monitor, geometry, instance({ fg: '#00000080', fg2: '#33aaccff' }));
      expect(Object.keys(colors)).to.deep.equal(['fg', 'fg2']);
      expect(colors.fg).to.match(/^#[0-9a-f]{6}80$/);
      expect(colors.fg2).to.match(/^#[0-9a-f]{6}ff$/);
      // vivid: the orange boat first (lightened against the strip's average), not the sky outside the window
      const rgb = [1, 3, 5].map(index => parseInt(colors.fg.slice(index, index + 2), 16));
      expect(toHsl(rgb)[0]).to.be.closeTo(toHsl([230, 120, 20])[0], 2);
      expect(contrastRatio(rgb, shownAverage(stripPixels(sample, monitor, geometry)))).to.be.at.least(3);
    });

    it('keeps the minimum contrast against a strip of one color', () => {
      const sample = bandedSample(4, 4, [[40, 60, 120]]);
      const colors = paletteColors(sample, monitor, geometry, instance({ fg: '#ffffffff' }, { minContrast: 4.5 }));
      const rgb = [1, 3, 5].map(index => parseInt(colors.fg.slice(index, index + 2), 16));
      expect(contrastRatio(rgb, [40, 60, 120])).to.be.at.least(4.5);
    });
  });

  describe('veilBackground', () => {
    const fill = (pixel, count = 10) => Array.from({ length: count }, () => pixel);
    const parts = veil => ({ rgb: [1, 3, 5].map(at => parseInt(veil.slice(at, at + 2), 16)), alpha: parseInt(veil.slice(7, 9), 16) / 255 });

    it('stays navy on a picture with next to no color, heavier on a bright one than a dark one', () => {
      const snow = veilBackground(fill([230, 232, 235]));
      expect(snow.slice(0, 7)).to.equal(DEFAULT_VEIL.slice(0, 7));
      expect(parts(snow).alpha).to.be.closeTo(0.65, 0.02);
      expect(parts(veilBackground(fill([20, 20, 22]))).alpha).to.be.closeTo(0.35, 0.01);
    });

    it('takes the hue of a colorful picture, kept very dark', () => {
      const dominant = (pixel, expected) => {
        const { rgb } = parts(veilBackground(fill(pixel)));
        expect(rgb.indexOf(Math.max(...rgb)), `${pixel}`).to.equal(expected);
        expect(Math.max(...rgb), `${pixel}`).to.be.below(40);
      };
      dominant([220, 40, 30], 0);
      dominant([30, 200, 40], 1);
      dominant([30, 40, 220], 2);
    });

    it('lets a colorful part count for more than a large gray one', () => {
      const { rgb } = parts(veilBackground([...fill([128, 128, 128], 8), ...fill([230, 30, 30], 2)]));
      expect(rgb[0]).to.be.above(rgb[2]);
    });

    it('darkens for a bright patch under the text, however dark the rest, and lets one highlight pass', () => {
      const dark = fill([20, 20, 22], 90);
      const patch = fill([240, 240, 240], 30);
      expect(parts(veilBackground([...dark, ...patch], 0, patch)).alpha).to.be.above(0.6);
      expect(parts(veilBackground([...dark, ...patch], 0, dark)).alpha).to.be.closeTo(0.35, 0.01);
      expect(parts(veilBackground([...dark, ...patch], 0, [...fill([20, 20, 22], 95), ...fill([240, 240, 240], 5)])).alpha).to.be.closeTo(0.35, 0.01);
    });

    it('counts a dim toward what it has to darken, and stays within its limits', () => {
      expect(parts(veilBackground(fill([200, 200, 200]), 50)).alpha).to.be.below(parts(veilBackground(fill([200, 200, 200]))).alpha);
      expect(parts(veilBackground(fill([255, 255, 255]))).alpha).to.be.at.most(0.85);
      expect(veilBackground([])).to.equal(DEFAULT_VEIL);
    });
  });
});
