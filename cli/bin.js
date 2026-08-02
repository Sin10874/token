#!/usr/bin/env node
process.removeAllListeners('warning');
process.on('warning', () => {});
require('tsx/cjs');
require('./bin.ts');
