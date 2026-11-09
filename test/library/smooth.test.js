import { expect } from 'chai';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  listSmoothWork, listSmoothed, removeStaleSmoothWork, rifeModel, smoothFactor, smoothSize, smoothVideo, smoothWorkPath, smoothedPath, smoothedReady,
  smoothedReversedPath, wantsSmoothing
} from '../../src/library/smooth.js';
import { silentLogger } from '../helpers/fakes.js';

describe('smooth', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-smooth-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('raises the frame rate by a whole factor until the speed shows the target', () => {
    expect(smoothFactor(30, 0.5, 60)).to.equal(4);
    expect(smoothFactor(30, 0.75, 60)).to.equal(3);
    expect(smoothFactor(25, 0.5, 60)).to.equal(5);
    expect(smoothFactor(59.94, 0.5, 60)).to.equal(2);
    expect(smoothFactor(29.97, 0.5, 60)).to.equal(4);
    expect(smoothFactor(23.976, 0.5, 60)).to.equal(5);
    expect(smoothFactor(60, 0.5, 60)).to.equal(2);
    expect(smoothFactor(60, 1, 60)).to.equal(1);
    expect(smoothFactor(30, 0.5, 30)).to.equal(2);
    // The default target is 30: 0.5 doubles a 30 fps video, 0.75 too (45 a second), 59.94 at 0.5 already shows 30
    expect(smoothFactor(30, 0.5)).to.equal(2);
    expect(smoothFactor(30, 0.75)).to.equal(2);
    expect(smoothFactor(59.94, 0.5)).to.equal(1);
    expect(smoothFactor(0, 0.5)).to.equal(1);
  });

  it('wants slowed, downloaded videos that show fewer frames than the target', () => {
    const video = { kind: 'video', path: '/m/v.mp4', speed: 0.5, fps: 30, duration: 10 };
    expect(wantsSmoothing(video)).to.equal(true);
    expect(wantsSmoothing({ ...video, speed: 1 })).to.equal(false);
    expect(wantsSmoothing({ ...video, kind: 'image' })).to.equal(false);
    expect(wantsSmoothing({ ...video, path: null })).to.equal(false);
    expect(wantsSmoothing({ ...video, fps: null })).to.equal(false);
    expect(wantsSmoothing({ ...video, fps: 240 })).to.equal(false);
    expect(wantsSmoothing({ ...video, fps: 59.94 })).to.equal(false);
    expect(wantsSmoothing({ ...video, fps: 59.94 }, 60)).to.equal(true);
  });

  it('makes the copy just large enough to cover the largest monitor, never larger than the video', () => {
    const media = { width: 2560, height: 1440 };
    expect(smoothSize(media, [{ width: 1920, height: 1080 }])).to.deep.equal({ width: 1920, height: 1080 });
    expect(smoothSize(media, [{ width: 1080, height: 1920 }])).to.deep.equal({ width: 2560, height: 1440 });
    expect(smoothSize({ width: 1280, height: 720 }, [{ width: 1920, height: 1080 }])).to.deep.equal({ width: 1280, height: 720 });
    expect(smoothSize({ width: 3840, height: 2160 }, [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }])).to.deep.equal({ width: 2560, height: 1440 });
    expect(smoothSize({ width: null, height: 1 })).to.equal(null);
  });

  it('names copies by item and speed, and finds the model beside the binary', async () => {
    const media = { id: 7, speed: 0.5, path: path.join(dir, 'v.mp4') };
    expect(smoothedPath(media, dir)).to.equal(path.join(dir, '7@0.5.mp4'));
    expect(smoothedReversedPath(media, dir)).to.equal(path.join(dir, '7@0.5.reversed.mp4'));
    expect(rifeModel('/opt/rife/rife-ncnn-vulkan')).to.equal('/opt/rife/rife-v4.6');
    await fs.outputFile(media.path, 'video');
    expect(smoothedReady(media, dir)).to.equal(false);
    await fs.outputFile(smoothedPath(media, dir), 'copy');
    expect(smoothedReady(media, dir)).to.equal(true);
    expect(smoothedReady({ ...media, speed: 0.75 }, dir)).to.equal(false);
    await fs.outputFile(path.join(dir, '7@0.5.reversed.mp4'), 'r');
    await fs.outputFile(path.join(dir, 'notes.txt'), 'x');
    expect((await listSmoothed(dir)).map(({ id, speed, reversed }) => ({ id, speed, reversed })).sort((a, b) => a.reversed - b.reversed))
      .to.deep.equal([{ id: 7, speed: 0.5, reversed: false }, { id: 7, speed: 0.5, reversed: true }]);
  });

  it('lists kept work folders, and clears only temporary leftovers', async () => {
    await fs.ensureDir(path.join(dir, '7@0.5.smooth.work'));
    await fs.ensureDir(path.join(dir, '8.1234.smooth.tmp'));
    await fs.outputFile(path.join(dir, '9.mp4.tmp'), 'x');
    expect((await listSmoothWork(dir)).map(({ id, speed }) => ({ id, speed }))).to.deep.equal([{ id: 7, speed: 0.5 }]);
    await removeStaleSmoothWork(dir);
    expect(await fs.readdir(dir)).to.deep.equal(['7@0.5.smooth.work']);
  });

  describe('smoothVideo', () => {
    let media, calls;

    beforeEach(async () => {
      const file = path.join(dir, 'media', 'v.mp4');
      await fs.outputFile(file, 'video');
      // 2.5 s at 10 fps: chunks of 20 frames from frames 0 and 20, the second the last
      media = { id: 3, kind: 'video', path: file, duration: 2.5, fps: 10, speed: 0.5, width: 640, height: 360 };
      calls = [];
    });

    // Stands in for ffmpeg and RIFE: extraction writes the frames asked for (taken, at most), RIFE writes -n frames
    function fakeExec({ taken = count => count, fail = () => false } = {}) {
      return async (file, args) => {
        calls.push([file, ...args]);
        if (fail(file, args)) throw new Error('failed');
        if (file === 'ffmpeg' && args.includes('-frames:v') && args.some(arg => arg.endsWith('%06d.png'))) {
          const count = taken(Number(args[args.indexOf('-frames:v') + 1]));
          for (let i = 1; i <= count; i++) await fs.outputFile(path.join(path.dirname(args.at(-1)), `${String(i).padStart(6, '0')}.png`), 'f');
        } else if (file === '/opt/rife') {
          const n = Number(args[args.indexOf('-n') + 1]);
          for (let i = 1; i <= n; i++) await fs.outputFile(path.join(args[args.indexOf('-o') + 1], `${String(i).padStart(8, '0')}.png`), 'f');
        } else {
          await fs.outputFile(args.at(-1), 'out');
        }
      };
    }

    it('interpolates each chunk with the next one\'s first frame, drops that frame and joins the chunks', async () => {
      const exec = fakeExec({ taken: count => (count === 21 ? 21 : 5) });
      const copy = await smoothVideo(media, dir, {
        rife: '/opt/rife', size: { width: 640, height: 360 }, exec, nice: false, logger: silentLogger, encoders: ['x264'], target: 60
      });
      expect(copy).to.equal(path.join(dir, '3@0.5.mp4'));
      const extracts = calls.filter(call => call[0] === 'ffmpeg' && call.some(arg => String(arg).endsWith('%06d.png')));
      // Chunk starts half a frame early so the seek lands on frames 0 and 20
      expect(extracts.map(call => [call[call.indexOf('-ss') + 1], call[call.indexOf('-frames:v') + 1]])).to.deep.equal([['0', '21'], ['1.95', '20']]);
      const rife = calls.filter(call => call[0] === '/opt/rife');
      // 10 fps at 0.5 shows 5 a second, so 60 needs a factor of 12: (21 - 1) * 12 + 1 and (5 - 1) * 12 + 1
      expect(rife.map(call => call[call.indexOf('-n') + 1])).to.deep.equal(['241', '49']);
      expect(rife[0]).to.include.members(['-m', '/opt/rife-v4.6', '-g', '0']);
      const encodes = calls.filter(call => call[0] === 'ffmpeg' && call.includes('-framerate'));
      // The shared frame is dropped from the first chunk; the last keeps all
      expect(encodes.map(call => [call[call.indexOf('-framerate') + 1], call[call.indexOf('-frames:v') + 1]])).to.deep.equal([['120', '240'], ['120', '49']]);
      expect(calls.at(-1)).to.include.members(['-f', 'concat', '-c', 'copy']);
      expect(await fs.readdir(dir)).to.include.members(['3@0.5.mp4', 'media']);
      expect((await fs.readdir(dir)).filter(name => name.endsWith('.tmp'))).to.deep.equal([]);
    });

    it('starts again with libx264 when VAAPI fails, and gives up when both do', async () => {
      const copy = await smoothVideo(media, dir, {
        rife: '/opt/rife', size: { width: 640, height: 360 }, exec: fakeExec({ fail: (file, args) => args.includes('h264_vaapi') }), nice: false, logger: silentLogger
      });
      expect(copy).to.equal(path.join(dir, '3@0.5.mp4'));
      await fs.remove(copy);
      expect(await smoothVideo(media, dir, {
        rife: '/opt/rife', size: { width: 640, height: 360 }, exec: fakeExec({ fail: file => file === '/opt/rife' }), nice: false, logger: silentLogger
      })).to.equal(null);
    });

    const options = (exec, extra = {}) => ({ rife: '/opt/rife', size: { width: 640, height: 360 }, exec, nice: false, logger: silentLogger, encoders: ['x264'], ...extra });
    const extractions = () => calls.filter(call => call[0] === 'ffmpeg' && call.some(arg => String(arg).endsWith('%06d.png'))).map(call => call[call.indexOf('-ss') + 1]);

    // Stops the job (as a load rise or a daemon restart does) once the first chunk is encoded
    async function stopAfterFirstChunk(extra) {
      const controller = new AbortController();
      const inner = fakeExec();
      const exec = async (file, args, ...rest) => {
        await inner(file, args, ...rest);
        if (file === 'ffmpeg' && args.includes('-framerate')) controller.abort();
      };
      expect(await smoothVideo(media, dir, options(exec, { signal: controller.signal, ...extra }))).to.equal(null);
    }

    it('keeps the finished chunks of a stopped job, and the next one carries on from them', async () => {
      await stopAfterFirstChunk();
      const work = smoothWorkPath(media, dir);
      expect(work).to.equal(path.join(dir, '3@0.5.smooth.work'));
      expect((await fs.readdir(work)).filter(name => name.endsWith('.mp4'))).to.deep.equal(['p00000.mp4']);
      calls = [];
      const copy = await smoothVideo(media, dir, options(fakeExec()));
      expect(copy).to.equal(smoothedPath(media, dir));
      // Only the second chunk is extracted again; the join takes both
      expect(extractions()).to.deep.equal(['1.95']);
      expect(await fs.pathExists(work)).to.equal(false);
      // A file moved since (a rating) is the same source: same size and modification time
      await stopAfterFirstChunk();
      const moved = path.join(dir, 'library', 'v.mp4');
      await fs.move(media.path, moved);
      media.path = moved;
      calls = [];
      await smoothVideo(media, dir, options(fakeExec()));
      expect(extractions()).to.deep.equal(['1.95']);
    });

    it('starts afresh when the kept chunks were made another way, and resumes with the encoder they used', async () => {
      await stopAfterFirstChunk();
      calls = [];
      // Another size: the chunks no longer fit
      await smoothVideo(media, dir, options(fakeExec(), { size: { width: 320, height: 180 } }));
      expect(extractions()).to.deep.equal(['0', '1.95']);

      // VAAPI failed before, so the kept chunks are libx264's: the next job goes on with libx264
      await fs.remove(smoothedPath(media, dir));
      await stopAfterFirstChunk({ encoders: ['x264'] });
      calls = [];
      await smoothVideo(media, dir, options(fakeExec(), { encoders: ['vaapi', 'x264'] }));
      expect(extractions()).to.deep.equal(['1.95']);
      expect(calls.some(call => call.includes('h264_vaapi'))).to.equal(false);
    });

    it('does nothing for a video that needs no smoothing, and stops without a copy when aborted', async () => {
      expect(await smoothVideo({ ...media, speed: 1 }, dir, { rife: '/opt/rife', size: { width: 640, height: 360 }, exec: fakeExec() })).to.equal(null);
      const controller = new AbortController();
      const exec = async (...args) => {
        controller.abort();
        return fakeExec()(...args);
      };
      expect(await smoothVideo(media, dir, { rife: '/opt/rife', size: { width: 640, height: 360 }, exec, signal: controller.signal, nice: false, encoders: ['x264'] })).to.equal(null);
      expect(await fs.pathExists(smoothedPath(media, dir))).to.equal(false);
    });
  });
});
