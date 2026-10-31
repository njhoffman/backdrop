import { expect } from 'chai';
import { closestMatches, editDistance } from '../../src/utils/closest.js';

describe('closest matches', () => {
  it('ranks containment first, then edit distance, and drops distant names', () => {
    const known = ['deep ocean', 'ocean', 'forest', 'oceans', 'mountain lake'];
    expect(closestMatches('ocean', known)).to.deep.equal(['deep ocean', 'ocean', 'oceans']);
    expect(closestMatches('forrest', known)).to.deep.equal(['forest']);
    expect(closestMatches('Forrest', known, 1)).to.deep.equal(['forest']);
    expect(closestMatches('zzz', known)).to.deep.equal([]);
  });

  it('counts insertions, deletions and substitutions', () => {
    expect(editDistance('kitten', 'sitting')).to.equal(3);
    expect(editDistance('', 'abc')).to.equal(3);
    expect(editDistance('same', 'same')).to.equal(0);
  });
});
