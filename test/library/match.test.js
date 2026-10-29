import { expect } from 'chai';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { matchFilters, hasMatchFilters, closestQueries, editDistance } from '../../src/library/match.js';

describe('match filters', () => {
  let db;
  beforeEach(() => { db = new DatabaseManager(); db.initialize(':memory:'); });
  afterEach(() => db.close());

  it('turns --query, --tag and --keywords into findMedia filters, accepting saved queries in any case', () => {
    db.addSearch('pexels', 'Ocean Waves');
    expect(matchFilters(db, { query: ['ocean waves'], tag: ['sunset'], keywords: ['sea'] }))
      .to.deep.equal({ queries: ['ocean waves'], tags: ['sunset'], keywords: ['sea'] });
    expect(matchFilters(db, {})).to.deep.equal({});
    expect(hasMatchFilters({})).to.be.false;
    expect(hasMatchFilters({ tags: ['a'] })).to.be.true;
  });

  it('rejects a query no search used, naming the closest saved queries', () => {
    for (const query of ['Ocean Waves', 'rainy window', 'city lights']) db.addSearch('pexels', query);
    expect(() => matchFilters(db, { query: ['ocean wave'] })).to.throw('No search used the query "ocean wave"; closest: "Ocean Waves"');
    expect(() => matchFilters(db, { query: ['Ocean Waves', 'zzzzzzzzzz'] })).to.throw(/"zzzzzzzzzz"$/);
    db.close(); db = new DatabaseManager(); db.initialize(':memory:');
    expect(() => matchFilters(db, { query: ['ocean'] })).to.throw('run a search first');
  });

  it('ranks containment first, then edit distance, and drops distant queries', () => {
    const known = ['deep ocean', 'ocean', 'forest', 'oceans', 'mountain lake'];
    expect(closestQueries('ocean', known)).to.deep.equal(['deep ocean', 'ocean', 'oceans']);
    expect(closestQueries('forrest', known)).to.deep.equal(['forest']);
    expect(editDistance('kitten', 'sitting')).to.equal(3);
    expect(editDistance('', 'abc')).to.equal(3);
  });
});
