import { configureOutput } from '../../src/utils/output.js';
import { configureNotify } from '../../src/utils/notify.js';

// Plain output for every test, even when mocha runs in a terminal; output tests opt back in
configureOutput({ interactive: false });

// notify-send never runs in tests; notifications sent are recorded here
export const notifications = [];
configureNotify({ exec: async (file, args) => { notifications.push(args); return `${notifications.length}\n`; } });
