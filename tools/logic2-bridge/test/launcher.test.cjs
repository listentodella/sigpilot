'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  logicProcessEnvironment,
  nativeHookArguments,
  parseArguments,
} = require('../index.cjs');

test('uses an automatically allocated public port by default', () => {
  assert.equal(parseArguments([]).port, 0);
  assert.equal(parseArguments(['--port', 'auto']).port, 0);
});

test('accepts a preferred public port', () => {
  assert.equal(parseArguments(['--port', '12472']).port, 12472);
  assert.throws(() => parseArguments(['--port', '65536']), /Invalid port/);
});

test('does not force the official Electron app into Node mode', () => {
  const environment = logicProcessEnvironment({
    ELECTRON_RUN_AS_NODE: '1',
    PATH: '/usr/bin',
  });
  assert.deepEqual(environment, { PATH: '/usr/bin' });
});

test('passes a matched profile to the data-driven native host', () => {
  assert.deepEqual(nativeHookArguments({
    compatibility: {
      profile: {
        id: 'logic-test',
        graph: { identity: 'ABCDEF01' },
        hook: {
          onDataBufferOffset: '0x1234',
          prologueHex: '554889e5',
        },
      },
    },
  }), ['logic-test', 'ABCDEF01', '0x1234', '554889e5']);
});
