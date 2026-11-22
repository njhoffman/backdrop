import { expect } from 'chai';
import sinon from 'sinon';
import { TagsCommand } from '../../src/commands/TagsCommand.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { makeConfig } from '../helpers/fakes.js';

describe('TagsCommand', () => {
  let db, printed, command;

  beforeEach(() => {
    db = new DatabaseManager();
    db.initialize(':memory:');
    printed = [];
    sinon.stub(console, 'log').callsFake(line => printed.push(line));
    sinon.stub(console, 'error').callsFake(line => printed.push(line));
    const add = (id, name, kind = 'video') => db.addMedia({ kind, source: 'local', source_id: id, path: `/m/${id}`, original_name: name });
    add(1, 'ocean night.mp4');
    add(2, 'ocean.mp4');
    add(3, 'ocean oak.jpg', 'image');
    db.addRating(add(4, 'night storm.mp4'), 0, '1920x1080');
    command = new TagsCommand(makeConfig(), db);
  });

  afterEach(() => {
    sinon.restore();
    db.close();
  });

  it('lists the playable items\' tags with counts, most used first', () => {
    command.run(undefined, {});
    expect(printed).to.deep.equal(['3  ocean', '1  night', '1  oak']);
  });

  it('narrows by prefix and kind, counts skipped items with --all, and says when the limit cut the list', () => {
    command.run('n', { all: true });
    expect(printed).to.deep.equal(['2  night']);
    printed.length = 0;
    command.run(undefined, { kind: 'image' });
    expect(printed).to.deep.equal(['1  oak', '1  ocean']);
    printed.length = 0;
    command.run(undefined, { limit: '1' });
    expect(printed[0]).to.equal('3  ocean');
    expect(printed[1]).to.include('First 1; --limit 0 lists every tag');
  });

  it('prints JSON, and refuses a bad limit or kind', () => {
    command.run('o', { json: true });
    expect(JSON.parse(printed.join(''))).to.deep.equal({ tags: [{ tag: 'ocean', count: 3 }, { tag: 'oak', count: 1 }], more: false });
    expect(() => command.run(undefined, { limit: '-1' })).to.throw('--limit must be a whole number');
    expect(() => command.run(undefined, { kind: 'gif' })).to.throw('--kind must be video or image');
  });

  it('says when nothing matches', () => {
    command.run('zz', {});
    expect(printed[0]).to.include('No tag starts with "zz"');
  });
});
