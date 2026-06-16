import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDef, DefError, loadDefFile, loadDefs, parseDef, validateDef } from '../src/defs.ts';

const delivery = {
  name: 'delivery',
  title: 'Software delivery',
  inputs: [{ name: 'proposal' }],
  loops: [
    { name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'plan it' },
    { name: 'builder', consumes: ['plan'], produces: ['pr'] },
    { name: 'reviewer', consumes: ['pr'], produces: ['verdict'] },
    { name: 'merger', consumes: ['verdict'], produces: ['merge'], terminal: true },
  ],
};

test('parseDef builds a valid def and fills defaults', () => {
  const def = parseDef(delivery);
  assert.equal(def.name, 'delivery');
  assert.equal(def.title, 'Software delivery');
  assert.equal(def.inputs[0]!.producer, 'human');
  assert.equal(def.inputs[0]!.seedOwed, false);
  const planner = def.loops[0]!;
  assert.equal(planner.cadence, '0s');
  assert.equal(planner.cadenceSecs, 0);
  assert.equal(planner.parallel, 1);
  assert.equal(planner.maxAttempts, 3);
  assert.equal(planner.workdir, 'main');
  assert.deepEqual(planner.invalidates, ['proposal']); // defaults to consumed stems
  assert.equal(def.loops[3]!.terminal, true);
});

test('parseDef parses cadence durations to seconds', () => {
  const def = parseDef({
    name: 'poll',
    inputs: [{ name: 'seed' }],
    loops: [{ name: 'watch', consumes: ['seed'], produces: ['report'], cadence: '30m' }],
  });
  assert.equal(def.loops[0]!.cadenceSecs, 1800);
});

test('parseDef classifies map and reduce wiring', () => {
  const def = parseDef({
    name: 'research',
    inputs: [{ name: 'question' }],
    loops: [
      { name: 'gather', consumes: ['question'], produces: ['gather.source[]'] },
      { name: 'fmt', consumes: ['gather.source[$i]'], produces: ['gather.source[$i].formatcheck'] },
      { name: 'synth', consumes: ['gather.source[*]'], produces: ['draft'] },
    ],
  });
  assert.equal(def.loops[1]!.consumes[0]!.mode, 'map');
  assert.equal(def.loops[2]!.consumes[0]!.mode, 'reduce');
});

test('rejects a non-object definition', () => {
  assert.throws(() => parseDef('nope'), DefError);
  assert.throws(() => parseDef(null), DefError);
});

test('rejects a missing/blank name', () => {
  assert.throws(() => parseDef({ loops: [{ name: 'a' }] }), DefError);
  assert.throws(() => parseDef({ name: 'has space', loops: [{ name: 'a' }] }), /alphanumeric/);
});

test('rejects a workflow with no loops', () => {
  assert.throws(() => parseDef({ name: 'empty', inputs: [{ name: 'x' }] }), /at least one loop/);
});

test('validateDef flags a dangling consume', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    loops: [{ name: 'one', consumes: ['a'], produces: ['b'] }, { name: 'two', consumes: ['nope'], produces: ['c'] }],
  }));
  assert.ok(errors.some((e) => e.includes("nothing produces 'nope'")), errors.join('; '));
});

test('validateDef flags two producers for one artifact', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    loops: [
      { name: 'one', consumes: ['a'], produces: ['x'] },
      { name: 'two', consumes: ['a'], produces: ['x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('two producers')), errors.join('; '));
});

test('validateDef flags an input that collides with a loop name', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'planner' }],
    loops: [{ name: 'planner', consumes: ['planner'], produces: ['plan'] }],
  }));
  assert.ok(errors.some((e) => e.includes('both an input and a loop')), errors.join('; '));
});

test('validateDef flags a map consume without a per-element produce', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'gather', consumes: ['q'], produces: ['set[]'] },
      { name: 'broken', consumes: ['set[$i]'], produces: ['summary'] }, // singleton, not map
    ],
  }));
  assert.ok(errors.some((e) => e.includes('produces no per-element')), errors.join('; '));
});

test('validateDef flags a reduce over a non-collection', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [{ name: 'synth', consumes: ['q', 'ghost[*]'], produces: ['draft'] }],
  }));
  assert.ok(errors.some((e) => e.includes("no loop produces 'ghost[]'")), errors.join('; '));
});

test('validateDef detects a dependency cycle', () => {
  const errors = validateDef(buildDef({
    name: 'loopy',
    inputs: [],
    loops: [
      { name: 'a', consumes: ['y'], produces: ['x'] },
      { name: 'b', consumes: ['x'], produces: ['y'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('dependency cycle')), errors.join('; '));
});

test('the knock-back graph is NOT a cycle (reject is runtime, not a dep edge)', () => {
  // reviewer consumes pr and produces verdict; builder consumes plan produces pr.
  // The reject feedback is a runtime action, not a consume edge, so this is a DAG.
  const errors = validateDef(parseDef(delivery));
  assert.deepEqual(errors, []);
});

test('buildDef rejects consumes/produces that are not a list of strings', () => {
  assert.throws(
    () => buildDef({ name: 'bad', inputs: [{ name: 'a' }], loops: [{ name: 'x', consumes: 'a', produces: ['y'] }] }),
    /must be a list of strings/,
  );
  assert.throws(
    () => buildDef({ name: 'bad', inputs: [{ name: 'a' }], loops: [{ name: 'x', consumes: ['a'], produces: [42] }] }),
    /must be a list of strings/,
  );
});

test('parseDef aggregates validation errors into a single thrown DefError', () => {
  assert.throws(
    () =>
      parseDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        loops: [
          { name: 'one', consumes: ['a'], produces: ['b'] },
          { name: 'two', consumes: ['nope'], produces: ['c'] },
        ],
      }),
    /invalid workflow 'bad'[\s\S]*nothing produces 'nope'/,
  );
});

test('validateDef flags more than one map consume in a loop', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g1', consumes: ['q'], produces: ['a[]'] },
      { name: 'g2', consumes: ['q'], produces: ['b[]'] },
      { name: 'multi', consumes: ['a[$i]', 'b[$i]'], produces: ['a[$i].x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('more than one map consume')), errors.join('; '));
});

test('validateDef flags more than one reduce consume in a loop', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g1', consumes: ['q'], produces: ['a[]'] },
      { name: 'g2', consumes: ['q'], produces: ['b[]'] },
      { name: 'multi', consumes: ['a[*]', 'b[*]'], produces: ['draft'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('more than one reduce consume')), errors.join('; '));
});

test('validateDef flags a loop that mixes a map and a reduce consume', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g', consumes: ['q'], produces: ['a[]'] },
      { name: 'mix', consumes: ['a[$i]', 'a[*]'], produces: ['a[$i].x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('mixes a map and a reduce')), errors.join('; '));
});

test('validateDef flags a per-element produce with no map consume to bind it', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g', consumes: ['q'], produces: ['a[]'] },
      { name: 'weird', consumes: ['q'], produces: ['a[$i].x'] }, // map produce, no $i consume
    ],
  }));
  assert.ok(errors.some((e) => e.includes('no map ($i) consume to bind it')), errors.join('; '));
});

test('loadDefs discovers a workflow.yaml inside a subdirectory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-defs-sub-'));
  // a flat file...
  writeFileSync(
    join(dir, 'flat.yaml'),
    'name: flat\ninputs:\n  - name: x\nloops:\n  - name: a\n    consumes: [x]\n    produces: [y]\n',
  );
  // ...and a packaged subdirectory with its own workflow.yaml
  const sub = join(dir, 'packaged');
  mkdirSync(sub);
  writeFileSync(
    join(sub, 'workflow.yaml'),
    'name: packaged\ninputs:\n  - name: seed\nloops:\n  - name: run\n    consumes: [seed]\n    produces: [out]\n',
  );
  // a subdirectory WITHOUT a workflow.yaml is silently skipped, not an error
  mkdirSync(join(dir, 'empty-dir'));

  const all = loadDefs(dir);
  assert.deepEqual([...all.keys()].sort(), ['flat', 'packaged']);
});

test('loadDefFile and loadDefs read YAML from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-defs-'));
  writeFileSync(
    join(dir, 'delivery.yaml'),
    [
      'name: delivery',
      'inputs:',
      '  - name: proposal',
      'loops:',
      '  - name: planner',
      '    consumes: [proposal]',
      '    produces: [plan]',
      '    body: |',
      '      Plan ${WORKFLOW}.',
      '  - name: builder',
      '    consumes: [plan]',
      '    produces: [pr]',
    ].join('\n'),
  );
  const single = loadDefFile(join(dir, 'delivery.yaml'));
  assert.equal(single.name, 'delivery');
  assert.equal(single.loops[0]!.body.trim(), 'Plan ${WORKFLOW}.');

  const all = loadDefs(dir);
  assert.deepEqual([...all.keys()], ['delivery']);
});
