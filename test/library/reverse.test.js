import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  chunkSeconds, chunkStarts, encodeCounts, listReverseWork, listReversed, recordEncode, removeReversed, removeStaleWork, reverseVideo, reverseWorkPath, reversedPath, reversedReady, run
} from '../../src/library/reverse.js';
import { silentLogger } from '../helpers/fakes.js';
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

    it('covers the whole video without a chunk that starts at its last half frame', () => {
      expect(chunkStarts(2, 0.5, 10)).to.deep.equal([0, 0.5, 1, 1.5]);
      expect(chunkStarts(2.03, 0.5, 10)).to.deep.equal([0, 0.5, 1, 1.5]);
      expect(chunkStarts(2.1, 0.5, 10)).to.deep.equal([0, 0.5, 1, 1.5, 2]);
    });
  });

  describe('reverseVideo', () => {
    let media, calls;

    beforeEach(async () => {
      const file = path.join(dir, 'media', 'clip.mp4');
      await fs.outputFile(file, 'video');
      media = { id: 7, kind: 'video', path: file, duration: 2.5, width: 1280, height: 720, fps: 24 };
      calls = [];
    });

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
      const target = await reverseVideo(media, bounceDir, { exec: fakeExec(), logger: silentLogger, encoders: ['x264'] });
      expect(target).to.equal(reversedPath(media, bounceDir));
      expect(await fs.readFile(target, 'utf8')).to.equal('out');
      expect(calls).to.have.length(3);
      expect(calls[0].slice(0, 3)).to.deep.equal(['nice', '-n', '19']);
      expect(calls[0]).to.include.members(['-ss', '0', '-t', '2', '-vf', 'reverse', 'libx264']);
      expect(calls[1]).to.include.members(['-ss', '2']);
      expect(calls[2]).to.include.members(['-f', 'concat', '-c', 'copy']);
      // The work folder is gone, the list went with it
      expect(await fs.readdir(bounceDir)).to.deep.equal(['7.mp4']);
    });

    it('lists the chunks in reverse order for the join', async () => {
      let list;
      const exec = async (file, args) => {
        if (args.includes('concat')) list = await fs.readFile(args[args.indexOf('-i') + 1], 'utf8');
        await fs.outputFile(args.at(-1), 'out');
      };
      await reverseVideo(media, dir, { exec, encoders: ['x264'], nice: false });
      expect(list).to.equal("file 'c00001.mp4'\nfile 'c00000.mp4'\n");
    });

    it('starts again with libx264 when VAAPI fails, and gives up when both do', async () => {
      const target = await reverseVideo(media, dir, { exec: fakeExec({ fail: args => args.includes('h264_vaapi') }), logger: silentLogger });
      expect(target).to.equal(reversedPath(media, dir));
      expect(calls[0]).to.include('h264_vaapi');
      expect(calls.slice(1).every(call => !call.includes('h264_vaapi'))).to.equal(true);

      calls = [];
      await fs.remove(target);
      expect(await reverseVideo(media, dir, { exec: fakeExec({ fail: () => true }), logger: silentLogger })).to.equal(null);
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
      expect(await reverseVideo(media, dir, { exec, logger })).to.equal(null);
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
      expect(await reverseVideo(media, dir, { exec, signal: controller.signal, encoders: ['x264'] })).to.equal(null);
      // No copy; the finished chunk stays for the next job
      expect(await fs.readdir(dir)).to.deep.equal(['7.reverse.work', 'media']);
    });

    // Stops the job (as a load rise or a daemon restart does) once the first chunk is encoded
    async function stopAfterFirstChunk(encoders = ['x264']) {
      const controller = new AbortController();
      const inner = fakeExec();
      const exec = async (file, args) => {
        await inner(file, args);
        controller.abort();
      };
      expect(await reverseVideo(media, dir, { exec, signal: controller.signal, encoders, logger: silentLogger })).to.equal(null);
    }

    it('keeps the finished chunks of a stopped job, and the next one carries on from them with the same encoder', async () => {
      await stopAfterFirstChunk(['vaapi', 'x264']);
      const work = reverseWorkPath(media, dir);
      expect(work).to.equal(path.join(dir, '7.reverse.work'));
      expect((await fs.readdir(work)).filter(name => name.endsWith('.mp4'))).to.deep.equal(['c00000.mp4']);
      calls = [];
      expect(await reverseVideo(media, dir, { exec: fakeExec(), logger: silentLogger })).to.equal(reversedPath(media, dir));
      // Only the second chunk and the join; still VAAPI
      expect(calls).to.have.length(2);
      expect(calls[0]).to.include.members(['-ss', '2', 'h264_vaapi']);
      expect(await fs.pathExists(work)).to.equal(false);
    });

    it('starts afresh when the kept chunks were made from another file or another way', async () => {
      await stopAfterFirstChunk();
      // download --upgrade replaced the video
      await fs.outputFile(media.path, 'a larger video');
      calls = [];
      await reverseVideo(media, dir, { exec: fakeExec(), logger: silentLogger, encoders: ['x264'] });
      expect(calls).to.have.length(3);
      await fs.remove(reversedPath(media, dir));
      await stopAfterFirstChunk();
      calls = [];
      // The kept chunks used libx264, which this job may not use
      await reverseVideo(media, dir, { exec: fakeExec(), logger: silentLogger, encoders: ['vaapi'] });
      expect(calls).to.have.length(3);
    });

    it('lists kept work folders by the id they are for', async () => {
      await fs.ensureDir(path.join(dir, '7.reverse.work'));
      await fs.ensureDir(path.join(dir, '3@0.5.reversed.reverse.work'));
      await fs.ensureDir(path.join(dir, '3@0.5.smooth.work'));
      expect((await listReverseWork(dir)).map(work => work.key).sort()).to.deep.equal(['3@0.5.reversed', '7']);
      expect(await listReverseWork(path.join(dir, 'missing'))).to.deep.equal([]);
    });

    it('skips items with no file or length', async () => {
      expect(await reverseVideo({ ...media, path: null }, dir, { exec: fakeExec() })).to.equal(null);
      expect(await reverseVideo({ ...media, duration: 0 }, dir, { exec: fakeExec() })).to.equal(null);
      expect(calls).to.deep.equal([]);
    });
  });

  describe('files', () => {
    it('is ready only when the copy is no older than the video', async () => {
      const file = path.join(dir, 'clip.mp4');
      await fs.outputFile(file, 'video');
      const media = { id: 3, path: file };
      expect(reversedReady(media, dir)).to.equal(false);
      await fs.outputFile(reversedPath(media, dir), 'reversed');
      expect(reversedReady(media, dir)).to.equal(true);
      expect(reversedReady(media, undefined)).to.equal(false);
      await removeReversed(media, dir);
      expect(reversedReady(media, dir)).to.equal(false);
    });

    it('lists finished copies oldest first, leaving out work folders and other files', async () => {
      await fs.outputFile(path.join(dir, '5.mp4'), 'abc');
      await fs.outputFile(path.join(dir, '6.mp4'), 'a');
      await fs.outputFile(path.join(dir, '7.1.tmp', 'c00000.mp4'), 'chunk');
      await fs.outputFile(path.join(dir, 'notes.txt'), 'x');
      const old = new Date(Date.now() - 60000);
      await fs.utimes(path.join(dir, '6.mp4'), old, old);
      expect((await listReversed(dir)).map(({ id, size }) => ({ id, size }))).to.deep.equal([{ id: 6, size: 1 }, { id: 5, size: 3 }]);
      expect(await listReversed(path.join(dir, 'missing'))).to.deep.equal([]);
    });

    it('removes work folders a daemon left behind and keeps finished copies', async () => {
      await fs.outputFile(path.join(dir, '4.123.tmp', 'c00000.mp4'), 'chunk');
      await fs.outputFile(path.join(dir, '4.mp4'), 'reversed');
      await removeStaleWork(dir);
      expect(await fs.readdir(dir)).to.deep.equal(['4.mp4']);
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
      const media = { id: 1, kind: 'video', path: file, duration: 2.3, width: 96, height: 64, fps: 10 };
      const target = await reverseVideo(media, path.join(dir, 'bounce'), { encoders: ['x264'], nice: false });
      const frames = async video => Number((await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v',
        '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', video])).trim());
      expect(target).to.not.equal(null);
      expect(await frames(target)).to.equal(await frames(file));
    });
  });
});
