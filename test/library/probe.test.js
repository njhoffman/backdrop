import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { parseProbe, parseFrameRate, probeMedia, meetsMinimum, isAnimatedWebp, UnsupportedMedia, ANIMATED_WEBP } from '../../src/library/probe.js';

const probeJson = (stream, format) => ({ streams: stream ? [stream] : [], format });

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('probe', () => {
  it('parses ffprobe frame rates and treats 0/0 as unknown', () => {
    expect(parseFrameRate('25/1')).to.equal(25);
    expect(parseFrameRate('24000/1001')).to.equal(23.976);
    expect(parseFrameRate('0/0')).to.be.null;
    expect(parseFrameRate(undefined)).to.be.null;
  });

  describe('parseProbe', () => {
    it('classifies still images by their single-frame formats', () => {
      expect(parseProbe(probeJson({ codec_name: 'png', width: 2560, height: 1440 }, { format_name: 'png_pipe' })))
        .to.deep.equal({ kind: 'image', width: 2560, height: 1440, duration: null, fps: null });
      expect(parseProbe(probeJson({ codec_name: 'mjpeg', width: 800, height: 600 }, { format_name: 'image2', duration: '0.04' })).kind)
        .to.equal('image');
    });

    it('classifies GIFs and videos with their duration', () => {
      expect(parseProbe(probeJson({ codec_name: 'gif', width: 320, height: 240 }, { format_name: 'gif', duration: '1.5' })))
        .to.deep.equal({ kind: 'gif', width: 320, height: 240, duration: 1.5, fps: null });
      expect(parseProbe(probeJson({ codec_name: 'h264', width: 3840, height: 2160, avg_frame_rate: '30000/1001' }, { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '30.0' })))
        .to.deep.equal({ kind: 'video', width: 3840, height: 2160, duration: 30, fps: 29.97 });
    });

    it('swaps dimensions for videos rotated a quarter turn', () => {
      const rotated = probeJson(
        { codec_name: 'h264', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
        { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5' }
      );
      expect(parseProbe(rotated)).to.include({ width: 1080, height: 1920 });

      const flipped = probeJson(
        { codec_name: 'h264', width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] },
        { format_name: 'matroska,webm', duration: '5' }
      );
      expect(parseProbe(flipped)).to.include({ width: 1920, height: 1080 });
    });

    it('accepts a JSON string and returns null without a picture stream', () => {
      expect(parseProbe(JSON.stringify(probeJson(null, { format_name: 'mp3' })))).to.be.null;
      expect(parseProbe(probeJson({ codec_name: 'png' }, { format_name: 'png_pipe' }))).to.be.null;
    });
  });

  describe('animated WebP', () => {
    // RIFF header, WEBP, then the first chunk's FourCC and size, and the VP8X flags byte
    const header = (fourcc, flags = 0) => Buffer.concat([
      Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(`WEBP${fourcc}`), Buffer.alloc(4), Buffer.from([flags])
    ]);
    const still = { kind: 'image', width: 2560, height: 1440, duration: null, fps: null };
    const exec = info => async () => JSON.stringify(info
      ? { streams: [{ width: info.width, height: info.height }], format: { format_name: 'webp_pipe' } }
      : { streams: [{ width: 0, height: 0 }], format: { format_name: 'webp_pipe' } });

    it('is recognized by the animation flag of the extended chunk', () => {
      expect(isAnimatedWebp(header('VP8X', 0x02))).to.be.true;
      expect(isAnimatedWebp(header('VP8X', 0x12))).to.be.true;
      expect(isAnimatedWebp(header('VP8X', 0x10))).to.be.false;
      expect(isAnimatedWebp(header('VP8 ', 0x02))).to.be.false;
      expect(isAnimatedWebp(Buffer.from('RIFF'))).to.be.false;
    });

    it('is rejected with its reason when FFmpeg cannot decode it', async () => {
      let error;
      await probeMedia('/a.webp', exec(null), async () => header('VP8X', 0x02)).catch(caught => { error = caught; });

      expect(error).to.be.instanceOf(UnsupportedMedia);
      expect(error.message).to.equal(ANIMATED_WEBP);
    });

    it('plays as an animation when FFmpeg can decode it', async () => {
      expect((await probeMedia('/a.WEBP', exec(still), async () => header('VP8X', 0x02))).kind).to.equal('gif');
    });

    it('leaves still WebP and other formats alone, reading no header for them', async () => {
      let reads = 0;
      const read = async () => { reads++; return header('VP8X', 0); };

      expect(await probeMedia('/a.webp', exec(still), read)).to.deep.equal(still);
      expect(await probeMedia('/a.webp', exec(null), read)).to.be.null;
      expect(await probeMedia('/a.png', exec(still), read)).to.deep.equal(still);
      expect(reads).to.equal(2);
    });
  });

  describe('meetsMinimum', () => {
    it('compares the long and short sides so orientation does not matter', () => {
      expect(meetsMinimum({ width: 1024, height: 768 }, 1024, 768)).to.be.true;
      expect(meetsMinimum({ width: 768, height: 1024 }, 1024, 768)).to.be.true;
      expect(meetsMinimum({ width: 1023, height: 768 }, 1024, 768)).to.be.false;
      expect(meetsMinimum({ width: 2000, height: 700 }, 1024, 768)).to.be.false;
      expect(meetsMinimum({ width: 700, height: 2000 }, 768, 1024)).to.be.false;
    });
  });

  describe('probeMedia with ffprobe', function () {
    this.timeout(15000);
    let tempDir;

    before(function () {
      if (!hasCommand('ffprobe') || !hasCommand('ffmpeg')) {
        this.skip();
      }
    });

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-probe-'));
    });

    afterEach(async () => {
      await fs.remove(tempDir);
    });

    const make = (name, ...args) => {
      const file = path.join(tempDir, name);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', ...args, file]);
      return file;
    };

    it('detects real images, GIFs and videos', async () => {
      const png = make('a.png', '-i', 'testsrc2=size=1280x720', '-frames:v', '1');
      const jpg = make('a.jpg', '-i', 'testsrc2=size=640x480', '-frames:v', '1');
      const gif = make('a.gif', '-i', 'testsrc2=size=320x240:rate=5:duration=1');
      const mp4 = make('a.mp4', '-i', 'testsrc2=size=1280x720:rate=10:duration=1', '-pix_fmt', 'yuv420p');

      expect(await probeMedia(png)).to.deep.equal({ kind: 'image', width: 1280, height: 720, duration: null, fps: null });
      expect((await probeMedia(jpg)).kind).to.equal('image');
      expect((await probeMedia(gif)).kind).to.equal('gif');
      expect(await probeMedia(mp4)).to.deep.include({ kind: 'video', width: 1280, height: 720, fps: 10 });
      expect((await probeMedia(gif)).fps).to.equal(5);
    });

    it('rejects or animates an animated WebP, depending on the FFmpeg', async function () {
      const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
      if (!encoders.includes('libwebp_anim')) this.skip();
      const webp = make('a.webp', '-i', 'testsrc2=size=320x240:rate=5:duration=1', '-c:v', 'libwebp_anim', '-loop', '0');

      const result = await probeMedia(webp).catch(error => error);

      if (result instanceof Error) expect(result.message).to.equal(ANIMATED_WEBP);
      else expect(result.kind).to.equal('gif');
    });

    it('returns null for files that are not media', async () => {
      // ffprobe exits 0 here and reports a 0x0 mjpeg stream
      const fake = path.join(tempDir, 'fake.jpg');
      await fs.writeFile(fake, 'not an image');
      expect(await probeMedia(fake)).to.be.null;
    });
  });
});
