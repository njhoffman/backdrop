import { configureOutput } from '../../src/utils/output.js';

// Plain output for every test, even when mocha runs in a terminal; output tests opt back in
configureOutput({ interactive: false });
