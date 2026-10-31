import { expect } from 'chai';
import { ask } from '../../src/utils/prompts.js';

describe('ask', () => {
  const failure = name => Object.assign(new Error(name), { name });

  it('passes the options to the prompt and returns its answer', async () => {
    expect(await ask(async options => options.message, { message: 'Action:' })).to.equal('Action:');
  });

  it('answers null on Ctrl-C and rethrows every other error', async () => {
    expect(await ask(async () => { throw failure('ExitPromptError'); }, {})).to.equal(null);
    const error = await ask(async () => { throw failure('ValidationError'); }, {}).catch(caught => caught);
    expect(error.name).to.equal('ValidationError');
  });
});
