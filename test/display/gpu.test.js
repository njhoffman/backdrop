import { expect } from 'chai';
import { parseDrmFdinfo, readGpuMemory } from '../../src/display/gpu.js';

const IRIS = `pos:\t0\nflags:\t02100002\nmnt_id:\t26\ndrm-driver:\ti915\ndrm-client-id:\t1210\n` +
  `drm-total-system0:\t9437184 KiB\ndrm-shared-system0:\t0\ndrm-total-stolen-system0:\t0\n`;
const AMD = `drm-driver:\tamdgpu\ndrm-client-id:\t77\ndrm-total-vram0:\t2 MiB\ndrm-total-gtt:\t1048576\n`;

describe('gpu memory', () => {
  it('parses a DRM client\'s total over its regions and units', () => {
    expect(parseDrmFdinfo(IRIS)).to.deep.equal({ client: '1210', bytes: 9437184 * 1024 });
    expect(parseDrmFdinfo(AMD)).to.deep.equal({ client: '77', bytes: 2 * 1024 ** 2 + 1048576 });
  });

  it('ignores descriptors that are not DRM clients', () => {
    expect(parseDrmFdinfo('pos:\t0\nflags:\t02\nmnt_id:\t15\n')).to.be.null;
  });

  it('counts a client shared by several descriptors once and skips descriptors closed meanwhile', async () => {
    const files = { '/proc/7/fdinfo/3': IRIS, '/proc/7/fdinfo/4': IRIS, '/proc/7/fdinfo/5': 'pos:\t0\n' };
    const bytes = await readGpuMemory(7, {
      readDir: async () => ['3', '4', '5', '6'],
      readFile: async file => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; }
    });
    expect(bytes).to.equal(9437184 * 1024);
  });

  it('is null without DRM clients or a readable fdinfo', async () => {
    expect(await readGpuMemory(7, { readDir: async () => ['0'], readFile: async () => 'pos:\t0\n' })).to.be.null;
    expect(await readGpuMemory(7, { readDir: async () => { throw new Error('EACCES'); } })).to.be.null;
  });
});
