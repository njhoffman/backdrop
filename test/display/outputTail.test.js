import { expect } from 'chai';
import { PassThrough } from 'stream';
import { outputTail } from '../../src/display/outputTail.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('outputTail', () => {
  it('keeps whole lines from every stream, joining lines split across chunks and skipping blank ones', async () => {
    const out = new PassThrough();
    const err = new PassThrough();
    const tail = outputTail([out, err]);

    err.write('X Error of failed request:  Bad');
    err.write('Match\n\n');
    out.write('[vo/gpu] warning\n');
    await flush();
    expect(tail.lines()).to.deep.equal(['X Error of failed request:  BadMatch', '[vo/gpu] warning']);
  });

  it('keeps only the last lines and the unterminated one at the end of the stream', async () => {
    const err = new PassThrough();
    const tail = outputTail([err], 3);

    err.write('1\n2\n3\n4\n');
    err.end('last without newline');
    await flush();
    expect(tail.lines()).to.deep.equal(['3', '4', 'last without newline']);
  });

  it('ignores missing streams and stream errors', async () => {
    const err = new PassThrough();
    const tail = outputTail([null, undefined, err]);
    err.emit('error', new Error('EPIPE'));
    expect(tail.lines()).to.deep.equal([]);
  });
});
