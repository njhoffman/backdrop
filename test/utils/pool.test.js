import { expect } from 'chai';
import { inOrder } from '../../src/utils/pool.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function collect(iterable) {
  const results = [];
  for await (const entry of iterable) results.push(entry);
  return results;
}

describe('inOrder', () => {
  it('yields results in input order whatever order they finish in', async () => {
    const results = await collect(inOrder([30, 0, 20, 10], async ms => { await wait(ms); return ms; }, { concurrency: 4 }));

    expect(results.map(entry => entry.result)).to.deep.equal([30, 0, 20, 10]);
  });

  it('runs at most `concurrency` items at once', async () => {
    let running = 0;
    let most = 0;
    await collect(inOrder([1, 2, 3, 4, 5, 6, 7], async () => {
      running++;
      most = Math.max(most, running);
      await wait(5);
      running--;
    }, { concurrency: 3 }));

    expect(most).to.equal(3);
  });

  it('reports a failed item as an error and keeps going', async () => {
    const results = await collect(inOrder([1, 2, 3], async n => {
      if (n === 2) throw new Error('two');
      return n;
    }));

    expect(results.map(entry => entry.error?.message ?? entry.result)).to.deep.equal([1, 'two', 3]);
  });

  it('starts no new work once asked to stop', async () => {
    const started = [];
    let stop = false;
    for await (const { item } of inOrder([1, 2, 3, 4, 5], async n => { started.push(n); }, { concurrency: 2, shouldStop: () => stop })) {
      if (item === 1) stop = true;
    }

    expect(started).to.deep.equal([1, 2, 3]);
  });

  it('treats a missing or invalid concurrency as one at a time', async () => {
    let most = 0;
    let running = 0;
    await collect(inOrder([1, 2, 3], async () => { running++; most = Math.max(most, running); await wait(1); running--; }, { concurrency: 0 }));

    expect(most).to.equal(1);
  });

  it('yields nothing for no items', async () => {
    expect(await collect(inOrder([], async () => 1))).to.deep.equal([]);
  });
});
