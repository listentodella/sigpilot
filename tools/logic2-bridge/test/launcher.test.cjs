'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  logicProcessEnvironment,
  nativeHookArguments,
  parseArguments,
  resolveRuntimeVersion,
} = require('../index.cjs');

test('uses an automatically allocated public port by default', () => {
  assert.equal(parseArguments([]).port, 0);
  assert.equal(parseArguments(['--port', 'auto']).port, 0);
});

test('accepts a preferred public port', () => {
  assert.equal(parseArguments(['--port', '12472']).port, 12472);
  assert.throws(() => parseArguments(['--port', '65536']), /Invalid port/);
});

test('requires an explicit opt-in for pending live-validation profiles', () => {
  assert.equal(parseArguments(['--allow-pending-profile']).allowPendingProfile, true);
  assert.equal(parseArguments([]).allowPendingProfile, false);
});

test('uses exact profile metadata only when installation metadata is unavailable', () => {
  const profile = { logicVersion: '2.4.46' };
  assert.equal(resolveRuntimeVersion('2.5.0', profile), '2.5.0');
  assert.equal(resolveRuntimeVersion(undefined, profile), '2.4.46');
  assert.equal(resolveRuntimeVersion(undefined, null), 'unknown');
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
