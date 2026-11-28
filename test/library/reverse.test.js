import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  ENCODERS, NVIDIA_DRIVER, SEEK, chunkFrames, chunkSeconds, chunkStarts, seekTime, defaultEncoders, encodeCounts, listReverseWork, listReversed, recordEncode, copyProblem, probeVideo, removeBrokenCopies, removeReversed, removeStaleWork, reverseVideo, reverseWorkPath, reversedPath, reversedReady, run
} from '../../src/library/reverse.js';
import { fakeSha, silentLogger } from '../helpers/fakes.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';

function hasTool(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('reverse', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bd-reverse-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  describe('chunks', () => {
    it('keeps a chunk of raw frames near 256 MiB, between a quarter second and two', () => {
      expect(chunkSeconds({ width: 2560, height: 1440, fps: 60 })).to.equal(0.8);
      expect(chunkSeconds({ width: 1280, height: 720, fps: 24 })).to.equal(2);
      expect(chunkSeconds({ width: 7680, height: 4320, fps: 60 })).to.equal(0.25);
      // Unknown size and rate: 1080p at 60
      expect(chunkSeconds({})).to.equal(1.43);
    });

    it('starts chunks at every chunkFrames-th of the frames the video holds, a quarter frame early', () => {
      expect(chunkFrames(0.5, 10)).to.equal(5);
      expect(chunkFrames(0.01, 10)).to.equal(1);
      expect(chunkStarts(2, 0.5, 10)).to.deep.equal([0, 0.475, 0.975, 1.475]);
      // 20.3 frames are 20: no chunk past the last
      expect(chunkStarts(2.03, 0.5, 10)).to.deep.equal([0, 0.475, 0.975, 1.475]);
      expect(chunkStarts(2.1, 0.5, 10)).to.deep.equal([0, 0.475, 0.975, 1.475, 1.975]);
    });

    it('seeks a quarter frame before a frame, never before the start', () => {
      expect(seekTime(0, 30)).to.equal(0);
      expect(seekTime(48, 30)).to.equal(1.591667);
      // 24000/1001 recorded as 23.976 is still within a quarter frame at frame 719
      expect(Math.abs(seekTime(719, 23.976) - (719 - 0.25) * 1001 / 24000)).to.be.below(0.25 / 24);
    });
  });

  describe('reverseVideo', () => {
    let media, calls;

    beforeEach(async () => {
      const file = path.join(dir, 'media', 'clip.mp4');
      await fs.outputFile(file, 'video');
      media = { id: 7, sha256: fakeSha(7), kind: 'video', path: file, duration: 2.5, width: 1280, height: 720, fps: 24 };
      calls = [];
    });

    // Ten frames per chunk, and the joined copy as many as the chunks the join was given hold
    async function fakeProbe(file) {
      if (path.basename(file) !== 'reversed.mp4') return { codec: 'h264', pixFmt: 'yuv420p', frames: 10 };
      const list = await fs.readFile(path.join(path.dirname(file), 'chunks.txt'), 'utf8');
      return { codec: 'h264', pixFmt: 'yuv420p', frames: 10 * list.trim().split('\n').length };
    }
    const reverse = (item, folder, options = {}) => reverseVideo(item, folder, { probe: fakeProbe, ...options });

    // Writes each ffmpeg output; fail(args) throws for the calls that should fail
    function fakeExec({ fail = () => false } = {}) {
      return async (file, args) => {
        calls.push([file, ...args]);
        if (fail(args)) throw new Error('ffmpeg failed\nmore detail');
        await fs.outputFile(args.at(-1), 'out');
        return '';
      };
    }

    it('reverses each chunk at the lowest priority and joins them last chunk first', async () => {
      const bounceDir = path.join(dir, 'bounce');
      const target = await reverse(media, bounceDir, { exec: fakeExec(), logger: silentLogger, encoders: ['x264'] });
      expect(target).to.equal(reversedPath(media, bounceDir));
      expect(await fs.readFile(target, 'utf8')).to.equal('out');
      expect(calls).to.have.length(3);
      expect(calls[0].slice(0, 3)).to.deep.equal(['nice', '-n', '19']);
      // 48 frames a chunk at 24 fps: the second starts at frame 48, and -t reads a frame more than trim keeps
      expect(calls[0]).to.include.members(['-ss', '0', '-t', '2.041667', '-vf', 'trim=end_frame=48,reverse', 'libx264']);
      expect(calls[1]).to.include.members(['-ss', '1.989583']);
      expect(calls[2]).to.include.members(['-f', 'concat', '-c', 'copy']);
      // The work folder is gone, the list went with it
      expect(await fs.readdir(bounceDir)).to.deep.equal([`${fakeSha(7)}.mp4`]);
    });

    it('lists the chunks in reverse order for the join', async () => {
      let list;
      const exec = async (file, args) => {
        if (args.includes('concat')) list = await fs.readFile(args[args.indexOf('-i') + 1], 'utf8');
        await fs.outputFile(args.at(-1), 'out');
      };
      await reverse(media, dir, { exec, encoders: ['x264'], nice: false });
      expect(list).to.equal("file 'c00001.mp4'\nfile 'c00000.mp4'\n");
    });

    it('encodes the video stream alone, without the timecode track ffmpeg adds even with -dn', async () => {
      await reverse(media, dir, { exec: fakeExec(), logger: silentLogger, encoders: ['x264'] });
      for (const call of calls) expect(call).to.include.members(['-map', '0:v:0']);
      expect(calls[0].slice(calls[0].indexOf('-write_tmcd'), calls[0].indexOf('-write_tmcd') + 2)).to.deep.equal(['-write_tmcd', '0']);
    });

    it('leaves a chunk with no frames out of the join', async () => {
      let list;
      const exec = async (file, args) => {
        if (args.includes('concat')) list = await fs.readFile(args[args.indexOf('-i') + 1], 'utf8');
        await fs.outputFile(args.at(-1), 'out');
      };
      // The second chunk starts past the last frame: an mp4 with no stream (null) or no frames
      for (const empty of [null, { codec: 'h264', pixFmt: 'yuv420p', frames: 0 }]) {
        const probe = async file => (path.basename(file) === 'c00001.mp4' ? empty : fakeProbe(file));
        expect(await reverseVideo(media, dir, { exec, probe, encoders: ['x264'], nice: false })).to.equal(reversedPath(media, dir));
        expect(list).to.equal("file 'c00000.mp4'\n");
        await fs.remove(reversedPath(media, dir));
      }
    });

    it('keeps no copy the join made unplayable, and no copy when no chunk holds a frame', async () => {
      const warnings = [];
      const logger = { ...silentLogger, warn: (message, meta) => warnings.push([message, meta]) };
      const broken = async file => (path.basename(file) === 'reversed.mp4' ? { codec: 'h264', pixFmt: null, frames: 20 } : fakeProbe(file));
      expect(await reverseVideo(media, dir, { exec: fakeExec(), probe: broken, logger, encoders: ['x264'] })).to.equal(null);
      expect(await fs.pathExists(reversedPath(media, dir))).to.equal(false);
      expect(warnings[0][1].error).to.equal('the joined copy cannot be played: the video stream has no pixel format');
      expect(await fs.pathExists(reverseWorkPath(media, dir))).to.equal(false);

      warnings.length = 0;
      expect(await reverseVideo(media, dir, { exec: fakeExec(), probe: async () => null, logger, encoders: ['x264'] })).to.equal(null);
      expect(warnings[0][1].error).to.equal('no chunk holds a frame');
    });

    it('starts again with libx264 when VAAPI fails, and gives up when both do', async () => {
      const target = await reverse(media, dir, { exec: fakeExec({ fail: args => args.includes('h264_vaapi') }), logger: silentLogger });
      expect(target).to.equal(reversedPath(media, dir));
      expect(calls[0]).to.include('h264_vaapi');
      expect(calls.slice(1).every(call => !call.includes('h264_vaapi'))).to.equal(true);

      calls = [];
      await fs.remove(target);
      expect(await reverse(media, dir, { exec: fakeExec({ fail: () => true }), logger: silentLogger })).to.equal(null);
      expect(await fs.pathExists(target)).to.equal(false);
    });

    it('stops quietly, trying no other encoder, when a rating moves the file mid-encode', async () => {
      const warnings = [];
      const logger = { ...silentLogger, warn: (message, meta) => warnings.push([message, meta]) };
      const exec = async (file, args) => {
        calls.push([file, ...args]);
        // The rating moves the file while the first chunk encodes; ffmpeg then fails to open it
        await fs.move(media.path, path.join(dir, 'trash', 'clip.mp4'));
        throw new Error('ffmpeg failed: No such file or directory');
      };
      expect(await reverse(media, dir, { exec, logger })).to.equal(null);
      expect(calls).to.have.length(1);
      expect(warnings).to.deep.equal([]);
      // Its work stays, for the job to resume from the new path
      expect(await fs.pathExists(reverseWorkPath(media, dir))).to.equal(true);
    });

    it('stops without a copy when aborted', async () => {
      const controller = new AbortController();
      const exec = async (file, args) => {
        controller.abort();
        await fs.outputFile(args.at(-1), 'out');
      };
      expect(await reverse(media, dir, { exec, signal: controller.signal, encoders: ['x264'] })).to.equal(null);
      // No copy; the finished chunk stays for the next job
      expect(await fs.readdir(dir)).to.deep.equal([`${fakeSha(7)}.reverse.work`, 'media']);
    });

    // Stops the job (as a load rise or a daemon restart does) once the first chunk is encoded
    async function stopAfterFirstChunk(encoders = ['x264']) {
      const controller = new AbortController();
      const inner = fakeExec();
      const exec = async (file, args) => {
        await inner(file, args);
        controller.abort();
      };
      expect(await reverse(media, dir, { exec, signal: controller.signal, encoders, logger: silentLogger })).to.equal(null);
    }

    it('keeps the finished chunks of a stopped job, and the next one carries on from them with the same encoder', async () => {
      await stopAfterFirstChunk(['vaapi', 'x264']);
      const work = reverseWorkPath(media, dir);
      expect(work).to.equal(path.join(dir, `${fakeSha(7)}.reverse.work`));
      expect((await fs.readdir(work)).filter(name => name.endsWith('.mp4'))).to.deep.equal(['c00000.mp4']);
      calls = [];
      expect(await reverse(media, dir, { exec: fakeExec(), logger: silentLogger })).to.equal(reversedPath(media, dir));
      // Only the second chunk and the join; still VAAPI
      expect(calls).to.have.length(2);
      expect(calls[0]).to.include.members(['-ss', '1.989583', 'h264_vaapi']);
      expect(await fs.pathExists(work)).to.equal(false);
    });

    it('starts afresh when the kept chunks were made from another file or another way', async () => {
      await stopAfterFirstChunk();
      // download --upgrade replaced the video
      await fs.outputFile(media.path, 'a larger video');
      calls = [];
      await reverse(media, dir, { exec: fakeExec(), logger: silentLogger, encoders: ['x264'] });
      expect(calls).to.have.length(3);
      await fs.remove(reversedPath(media, dir));
      await stopAfterFirstChunk();
      calls = [];
      // The kept chunks used libx264, which this job may not use
      await reverse(media, dir, { exec: fakeExec(), logger: silentLogger, encoders: ['vaapi'] });
      expect(calls).to.have.length(3);
    });

    it('lists kept work folders by the id they are for', async () => {
      await fs.ensureDir(path.join(dir, `${fakeSha(7)}.reverse.work`));
      await fs.ensureDir(path.join(dir, `${fakeSha(3)}@0.5.reversed.reverse.work`));
      await fs.ensureDir(path.join(dir, '3@0.5.smooth.work'));
      expect((await listReverseWork(dir)).map(work => work.key).sort()).to.deep.equal([`${fakeSha(3)}@0.5.reversed`, fakeSha(7)]);
      expect(await listReverseWork(path.join(dir, 'missing'))).to.deep.equal([]);
    });

    it('skips items with no file or length', async () => {
      expect(await reverse({ ...media, path: null }, dir, { exec: fakeExec() })).to.equal(null);
      expect(await reverse({ ...media, duration: 0 }, dir, { exec: fakeExec() })).to.equal(null);
      expect(calls).to.deep.equal([]);
    });
  });

  describe('checking copies', () => {
    it('reads the first video stream from ffprobe', async () => {
      const exec = async (file, args) => {
        expect(file).to.equal('ffprobe');
        expect(args.at(-1)).to.equal('/copy.mp4');
        return JSON.stringify({ streams: [{ codec_name: 'h264', pix_fmt: 'yuv420p', nb_frames: '724' }] });
      };
      expect(await probeVideo('/copy.mp4', { exec })).to.deep.equal({ codec: 'h264', pixFmt: 'yuv420p', frames: 724 });
      expect(await probeVideo('/copy.mp4', { exec: async () => JSON.stringify({ streams: [{ codec_name: 'h264', pix_fmt: 'unknown' }] }) }))
        .to.deep.equal({ codec: 'h264', pixFmt: null, frames: 0 });
      expect(await probeVideo('/copy.mp4', { exec: async () => '{"streams":[]}' })).to.equal(null);
    });

    it('removes the copies a probe finds fault with, and keeps those it cannot read', async () => {
      const files = ['good', 'broken', 'unreadable'].map(name => path.join(dir, `${name}.mp4`));
      for (const file of files) await fs.outputFile(file, 'copy');
      const probe = async file => {
        if (file.includes('unreadable')) throw new Error('ffprobe: moov atom not found\nmore');
        return file.includes('broken') ? { codec: 'h264', pixFmt: null, frames: 724 } : { codec: 'h264', pixFmt: 'yuv420p', frames: 724 };
      };
      const warnings = [];
      const logger = { ...silentLogger, warn: (message, meta) => warnings.push([message, meta]) };
      const removed = await removeBrokenCopies(files.map(file => ({ file })), { probe, logger });
      expect(removed.map(copy => copy.file)).to.deep.equal([files[1]]);
      expect(await Promise.all(files.map(file => fs.pathExists(file)))).to.deep.equal([true, false, true]);
      expect(warnings).to.deep.equal([['Removed a copy that cannot be played', { file: files[1], problem: 'the video stream has no pixel format' }]]);
      expect(await removeBrokenCopies([], { probe })).to.deep.equal([]);
    });

    it('says why a copy cannot be played', () => {
      const good = { codec: 'h264', pixFmt: 'yuv420p', frames: 48 };
      expect(copyProblem(good)).to.equal(null);
      expect(copyProblem(good, 48)).to.equal(null);
      expect(copyProblem(null)).to.equal('no video stream');
      expect(copyProblem({ ...good, pixFmt: null })).to.equal('the video stream has no pixel format');
      expect(copyProblem({ ...good, frames: 0 })).to.equal('no frames');
      expect(copyProblem(good, 50)).to.equal('48 frames where 50 were joined');
    });
  });

  describe('encoders', () => {
    it('tries NVENC, then libx264, where NVIDIA\'s driver is loaded, and VAAPI first elsewhere', () => {
      expect(defaultEncoders({ exists: file => file === '/proc/driver/nvidia/version' })).to.deep.equal(['nvenc', 'x264']);
      expect(defaultEncoders({ exists: () => false })).to.deep.equal(['vaapi', 'x264']);
    });

    it('encodes NVENC from 8-bit 4:2:0 frames, which a smoothed chunk keeps once the reverse is dropped', () => {
      expect(ENCODERS.nvenc.filter).to.equal('reverse,format=yuv420p');
      expect(ENCODERS.nvenc.filter.replace(/^reverse,?/, '')).to.equal('format=yuv420p');
      expect(ENCODERS.nvenc.output).to.include.members(['-c:v', 'h264_nvenc']);
    });
  });

  describe('files', () => {
    it('is ready while the copy named for the content exists, and never for an item without a sha256', async () => {
      const file = path.join(dir, 'clip.mp4');
      await fs.outputFile(file, 'video');
      const media = { id: 3, sha256: fakeSha(3), path: file };
      expect(reversedPath({ id: 3, path: file }, dir)).to.equal(null);
      expect(reversedReady({ id: 3, path: file }, dir)).to.equal(false);
      await removeReversed({ id: 3, path: file }, dir);
      expect(reversedReady(media, dir)).to.equal(false);
      await fs.outputFile(reversedPath(media, dir), 'reversed');
      expect(reversedReady(media, dir)).to.equal(true);
      expect(reversedReady(media, undefined)).to.equal(false);
      await removeReversed(media, dir);
      expect(reversedReady(media, dir)).to.equal(false);
    });

    it('lists finished copies oldest first, leaving out work folders and other files', async () => {
      await fs.outputFile(path.join(dir, `${fakeSha(5)}.mp4`), 'abc');
      await fs.outputFile(path.join(dir, `${fakeSha(6)}.mp4`), 'a');
      // An id name from before 2.87, which the daemon renames on start
      await fs.outputFile(path.join(dir, '8.mp4'), 'old');
      await fs.outputFile(path.join(dir, '7.1.tmp', 'c00000.mp4'), 'chunk');
      await fs.outputFile(path.join(dir, 'notes.txt'), 'x');
      const old = new Date(Date.now() - 60000);
      await fs.utimes(path.join(dir, `${fakeSha(6)}.mp4`), old, old);
      expect((await listReversed(dir)).map(({ sha256, size }) => ({ sha256, size }))).to.deep.equal([{ sha256: fakeSha(6), size: 1 }, { sha256: fakeSha(5), size: 3 }]);
      expect(await listReversed(path.join(dir, 'missing'))).to.deep.equal([]);
    });

    it('removes work folders a daemon left behind and keeps finished copies', async () => {
      await fs.outputFile(path.join(dir, '4.123.tmp', 'c00000.mp4'), 'chunk');
      await fs.outputFile(path.join(dir, `${fakeSha(4)}.mp4`), 'reversed');
      await removeStaleWork(dir);
      expect(await fs.readdir(dir)).to.deep.equal([`${fakeSha(4)}.mp4`]);
      await removeStaleWork(path.join(dir, 'missing'));
    });
  });

  describe('encode counts', () => {
    it('adds up each day\'s encodes and keeps the last week', () => {
      const db = new DatabaseManager();
      db.initialize(':memory:');
      try {
        const day = n => new Date(Date.UTC(2026, 10, n, 12));
        recordEncode(db, day(1), 10);
        for (let n = 2; n <= 9; n++) recordEncode(db, day(n), 5);
        recordEncode(db, day(9), 2.25);
        expect(encodeCounts(db, day(9))).to.deep.equal({ today: { count: 2, seconds: 7.3 }, yesterday: { count: 1, seconds: 5 } });
        expect(Object.keys(db.getSetting('bounce_encodes'))).to.have.length(7);
        expect(encodeCounts(db, day(20))).to.deep.equal({ today: { count: 0, seconds: 0 }, yesterday: { count: 0, seconds: 0 } });
      } finally {
        db.close();
      }
    });
  });

  describe('with ffmpeg', function () {
    this.timeout(60000);

    before(function () {
      if (!hasTool('ffmpeg') || !hasTool('ffprobe')) this.skip();
    });

    it('makes a playable copy with every frame of the video', async () => {
      const file = path.join(dir, 'clip.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10:duration=2.3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
      const media = { id: 1, sha256: fakeSha(1), kind: 'video', path: file, duration: 2.3, width: 96, height: 64, fps: 10 };
      const target = await reverseVideo(media, path.join(dir, 'bounce'), { encoders: ['x264'], nice: false });
      const frames = async video => Number((await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v',
        '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', video])).trim());
      expect(target).to.not.equal(null);
      expect(await frames(target)).to.equal(await frames(file));
    });

    // Where NVIDIA's encoder is there (minerva), the default order makes the copy with it, not with libx264 after a failure
    it('makes the copy with NVENC where it is available', async function () {
      const encoders = await run('ffmpeg', ['-hide_banner', '-encoders']).catch(() => '');
      if (!fs.existsSync(NVIDIA_DRIVER) || !encoders.includes('h264_nvenc')) this.skip();
      const file = path.join(dir, 'clip.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2.3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
      const media = { id: 1, sha256: fakeSha(1), kind: 'video', path: file, duration: 2.3, width: 320, height: 180, fps: 10 };
      const target = await reverseVideo(media, path.join(dir, 'bounce'), { encoders: defaultEncoders(), nice: false });
      expect(target).to.not.equal(null);
      const tags = await run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream_tags=encoder', '-of', 'csv=p=0', target]);
      expect(tags).to.match(/nvenc|NVIDIA/i);
    });

    // A copy is the video's frames in reverse, each once: no frame repeated or lost at a seam (24000/1001 at 2 s
    // chunks used to end between frames, and seeking half a frame early started each chunk a frame early)
    // Muxed with one timebase tick a frame (1/30), as Pexels videos often are, a seek half a frame early rounds to the
    // frame before; 24000/1001 is recorded as 23.976
    for (const [rate, fps, frames, timescale] of [['30', 30, 195, '30'], ['24000/1001', 23.976, 156, '24000']]) {
      it(`reverses every frame exactly once across chunk seams at ${rate}`, async () => {
        const file = path.join(dir, 'seams.mp4');
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=96x64:rate=${rate}:duration=6.5`,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-video_track_timescale', timescale, file]);
        const hashes = async video => (await run('ffmpeg', ['-v', 'error', '-i', video, '-map', '0:v:0', '-f', 'framemd5', '-']))
          .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
        const source = await hashes(file);
        expect(source).to.have.length(frames);
        const media = { id: 3, sha256: fakeSha(3), kind: 'video', path: file, duration: frames / fps, width: 96, height: 64, fps };
        expect(chunkStarts(media.duration, chunkSeconds(media), media.fps).length).to.be.above(2);
        // Lossless, so the copy's frames are the source's bit for bit and can be matched by hash
        ENCODERS.lossless = { input: [], filter: 'reverse', output: ['-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p'] };
        try {
          const target = await reverseVideo(media, path.join(dir, 'bounce'), { encoders: ['lossless'], nice: false, logger: silentLogger });
          expect(target).to.not.equal(null);
          expect(await hashes(target)).to.deep.equal([...source].reverse());
        } finally {
          delete ENCODERS.lossless;
          await fs.remove(path.join(dir, 'bounce'));
        }
      });
    }

    // The copy that hung mpv (2026-11-20): a source with a timecode tag, whose recorded length runs past its last
    // frame far enough for a chunk to start after it
    it('makes a playable copy of a video with a timecode whose length runs past its last frame', async () => {
      const file = path.join(dir, 'timecode.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=24:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-timecode', '00:01:42:23', file]);
      const media = { id: 2, sha256: fakeSha(2), kind: 'video', path: file, duration: 2.03, width: 96, height: 64, fps: 24 };
      // 49 frames by the recorded length, 48 in the file: the second chunk starts past the last
      expect(chunkStarts(media.duration, chunkSeconds(media), media.fps)).to.deep.equal([0, 1.989583]);
      const target = await reverseVideo(media, path.join(dir, 'bounce'), { encoders: ['x264'], nice: false, logger: silentLogger });
      expect(target).to.not.equal(null);
      expect(await probeVideo(target)).to.deep.equal({ codec: 'h264', pixFmt: 'yuv420p', frames: 48 });
      const streams = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', target])).streams;
      expect(streams.map(stream => stream.codec_type)).to.deep.equal(['video']);
    });
  });
});
