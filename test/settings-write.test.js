'use strict';

// The rebasing writer, now shared by the extension and the CLI.
//
// The defect it exists to prevent: a writer reads settings.json, spends time
// computing, then spreads its stale snapshot back over the file. Claude Code
// rewrites that file in place on every /model, /effort and approval, so whatever
// landed in between is reverted. These tests inject exactly that interleaving —
// the caller's snapshot and the file on disk deliberately disagree — which a
// naive `{ ...settings, permissions: { ...allow } }` spread cannot survive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createSettingsWriter, readSettingsState,
  SETTINGS_ABSENT, SETTINGS_PRESENT, SETTINGS_UNREADABLE, SETTINGS_UNREADABLE_CODE,
  SETTINGS_CONTENDED_CODE,
} = require('../src/settings-write');

function tempSettings(t, value) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-write-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'settings.json');
  if (value !== undefined) fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return {
    file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    writer: (options) => createSettingsWriter({ settingsPath: file, ...options }),
  };
}

test('a field added after the caller read is not reverted by the write', (t) => {
  // What the caller saw when it started.
  const snapshot = { model: 'claude-opus-5', permissions: { allow: ['Bash(git status)'] } };
  const env = tempSettings(t, snapshot);

  // What landed while the caller was computing: a new model, a brand-new deny
  // rule, and an approval the caller never saw.
  env.writer().readSettingsState();
  fs.writeFileSync(env.file, JSON.stringify({
    model: 'claude-sonnet-5',
    effortLevel: 'high',
    hooks: { PostToolUse: [{ matcher: 'Bash' }] },
    permissions: {
      allow: ['Bash(git status)', 'Bash(npm test)'],
      deny: ['Bash(rm -rf /*)'],
    },
  }, null, 2) + '\n');

  // The caller's intent, computed against its OWN stale snapshot.
  env.writer().writeAllow(snapshot, ['Bash(git *)']);

  const after = env.read();
  assert.equal(after.model, 'claude-sonnet-5', 'a concurrent model change must survive');
  assert.equal(after.effortLevel, 'high', 'a field the snapshot never had must survive');
  assert.deepEqual(after.hooks, { PostToolUse: [{ matcher: 'Bash' }] },
    'the hook registration must survive — losing it disables this tool silently');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf /*)'],
    'deny is the safety boundary: a concurrent rule must never be dropped');
  assert.ok(after.permissions.allow.includes('Bash(git *)'), 'the caller\'s addition lands');
  assert.ok(after.permissions.allow.includes('Bash(npm test)'),
    'an approval that arrived after the snapshot must survive');
});

test('a removal is replayed, so a deliberate prune still prunes', (t) => {
  // The other half of the contract: rebasing must not mean "ignore the caller".
  const snapshot = { permissions: { allow: ['Bash(git *)', 'Bash(rg *)'] } };
  const env = tempSettings(t, snapshot);
  fs.writeFileSync(env.file, JSON.stringify({
    permissions: { allow: ['Bash(git *)', 'Bash(rg *)', 'Bash(fd *)'] },
  }, null, 2) + '\n');

  env.writer().writeAllow(snapshot, ['Bash(git *)']);

  const allow = env.read().permissions.allow;
  assert.ok(!allow.includes('Bash(rg *)'), 'the entry the caller removed is gone');
  assert.ok(allow.includes('Bash(fd *)'), 'the entry it never saw is untouched');
});

test('an empty deny key is never invented', (t) => {
  const snapshot = { permissions: { allow: ['Bash(rg *)'] } };
  const env = tempSettings(t, snapshot);
  env.writer().writeAllow(snapshot, ['Bash(rg *)', 'Bash(fd *)']);
  assert.equal(Object.prototype.hasOwnProperty.call(env.read().permissions, 'deny'), false,
    'writing an empty deny key would misrepresent the user policy as having a boundary');
});

test('an unparseable settings.json is refused, not written over', (t) => {
  const env = tempSettings(t);
  fs.writeFileSync(env.file, '{ "permissions": ');  // caught mid-write

  assert.equal(readSettingsState(env.file).state, SETTINGS_UNREADABLE);
  assert.throws(
    () => env.writer().writeAllow({}, ['Bash(rg *)']),
    (err) => err.code === SETTINGS_UNREADABLE_CODE,
    'refusing is the whole point: the snapshot is often {} on this path, so writing '
      + 'would leave a settings.json holding nothing but permissions',
  );
  assert.equal(fs.readFileSync(env.file, 'utf8'), '{ "permissions": ', 'the file is untouched');
});

test('absent and unreadable are told apart', (t) => {
  const env = tempSettings(t);
  assert.equal(readSettingsState(env.file).state, SETTINGS_ABSENT,
    'absent means the backup should step in');
  fs.writeFileSync(env.file, '{}');
  assert.equal(readSettingsState(env.file).state, SETTINGS_PRESENT);
});

test('the injected write hook receives what actually landed', (t) => {
  // The extension passes its high-water-mark backup here. It has to be handed the
  // REBASED lists, not the caller's intent, or the backup records a file that was
  // never written.
  const snapshot = { permissions: { allow: ['Bash(rg *)'] } };
  const env = tempSettings(t, snapshot);
  fs.writeFileSync(env.file, JSON.stringify({
    permissions: { allow: ['Bash(rg *)', 'Bash(fd *)'], deny: ['Bash(mkfs* *)'] },
  }, null, 2) + '\n');

  const seen = [];
  env.writer({ onWrite: (allow, deny) => seen.push({ allow, deny }) })
    .writeAllow(snapshot, ['Bash(rg *)', 'Bash(git *)']);

  assert.equal(seen.length, 1, 'the hook fires once, after a successful write');
  assert.ok(seen[0].allow.includes('Bash(fd *)'), 'it sees the rebased allow list');
  assert.deepEqual(seen[0].deny, ['Bash(mkfs* *)'], 'and the deny list it must not lose');
  assert.deepEqual(seen[0].allow, env.read().permissions.allow,
    'what the hook records and what is on disk cannot disagree');
});


// ── writeTransform ───────────────────────────────────────────────────────────
//
// The other writer shape, for callers whose change cannot be expressed as an
// allow-list delta. `applyMax` and `applyBypass` both DELETE keys
// (permissions.defaultMode, hooks.PreToolUse) rather than nulling them, and
// writeAllow is a merge — `{ ...latest, permissions }` — which can never express
// a delete and can only carry permissions.allow. Routing MAX through it would
// silently drop the approve-hook registration, i.e. half the feature.

test('the transform runs against the file as it is NOW, not the caller read', (t) => {
  const env = tempSettings(t, { model: 'A', permissions: { allow: ['Bash(git status)'] } });

  // What lands while the caller is still deciding what to do.
  fs.writeFileSync(env.file, JSON.stringify({
    model: 'B',
    effortLevel: 'high',
    permissions: { allow: ['Bash(git status)', 'Bash(npm test)'] },
  }, null, 2) + '\n');

  let seen = null;
  const out = env.writer().writeTransform((latest) => {
    seen = latest;
    return { changed: true, settings: { ...latest, permissions: { ...latest.permissions, defaultMode: 'plan' } } };
  });

  // THIS is the assertion that fails if someone reverts to handing the transform
  // a caller-supplied snapshot. The disk assertions below can be satisfied by a
  // lucky merge; this one cannot.
  assert.equal(seen.model, 'B', 'the transform saw the newest read');
  assert.ok(seen.permissions.allow.includes('Bash(npm test)'),
    'including an approval that landed after the caller started');

  assert.equal(out.wrote, true);
  assert.equal(out.latest.model, 'B', 'and the caller is told which read it wrote onto');

  const disk = env.read();
  assert.equal(disk.model, 'B', 'the concurrent write survives');
  assert.equal(disk.effortLevel, 'high', 'including a key the caller never saw at all');
  assert.equal(disk.permissions.defaultMode, 'plan', 'and the transform still took effect');
});

test('a transform that changes nothing does not touch the file', (t) => {
  const env = tempSettings(t, { model: 'A', permissions: { allow: ['Bash(rg *)'] } });
  const before = fs.statSync(env.file).mtimeMs;
  const beforeBytes = fs.readFileSync(env.file, 'utf8');

  const out = env.writer().writeTransform((latest) => ({ changed: false, settings: latest, to: 'already' }));

  assert.equal(out.wrote, false);
  assert.equal(out.result.to, 'already',
    'the transform result comes back VERBATIM — callers read .error, .to, .switchedMode');
  assert.equal(fs.statSync(env.file).mtimeMs, before, 'not rewritten');
  assert.equal(fs.readFileSync(env.file, 'utf8'), beforeBytes);
});

test('an unreadable file is refused BEFORE the transform runs', (t) => {
  const env = tempSettings(t);
  // Truncated mid-array: somebody else's atomic write in progress.
  fs.writeFileSync(env.file, '{ "permissions": { "allow": [ ');

  const sideEffects = [];
  assert.throws(
    () => env.writer().writeTransform((latest) => {
      sideEffects.push('ran');
      return { changed: true, settings: latest };
    }),
    (err) => err.code === SETTINGS_UNREADABLE_CODE,
  );

  // The ordering is the whole point, not an implementation detail. applyMax
  // writes the allow-list snapshot as a side effect of being called, so a
  // transform that ran before the refusal would overwrite a real snapshot with
  // one taken from a file we then decline to write — turning MAX-on into
  // permanent loss of the allow list.
  assert.deepEqual(sideEffects, [], 'the transform was never invoked');
});

test('a delete survives the round trip, because this writer does not merge', (t) => {
  const env = tempSettings(t, { model: 'A', permissions: { allow: [], defaultMode: 'plan' } });

  env.writer().writeTransform((latest) => {
    const permissions = { ...latest.permissions };
    delete permissions.defaultMode;
    return { changed: true, settings: { ...latest, permissions } };
  });

  const disk = env.read();
  assert.equal('defaultMode' in disk.permissions, false,
    'the key is gone from the FILE — writeAllow could not express this at all');
  assert.equal(disk.model, 'A', 'and nothing else moved');
});

test('a transform that would drop a deny rule is refused, not obeyed', (t) => {
  const env = tempSettings(t, {
    permissions: { allow: ['Bash(rg *)'], deny: ['Bash(rm -rf /*)', 'Bash(curl *)'] },
  });
  const beforeBytes = fs.readFileSync(env.file, 'utf8');

  // deny is the safety boundary every other feature defers to. writeAllow
  // guarantees it additively; this writer writes verbatim, so it refuses to be
  // the thing that silently drops one. Neither real transform can trigger this —
  // it is a guard for the next author.
  assert.throws(
    () => env.writer().writeTransform((latest) => ({
      changed: true,
      settings: { ...latest, permissions: { allow: latest.permissions.allow } },
    })),
    /deny rule/,
  );
  assert.equal(fs.readFileSync(env.file, 'utf8'), beforeBytes, 'and nothing was written');
});

test('a file that keeps moving is reported, never written over', (t) => {
  const env = tempSettings(t, { model: 'A', permissions: { allow: [] } });
  let n = 0;

  // The transform itself is the concurrent writer: every attempt sees the file
  // change underneath it, which is the compare-and-swap's terminal case.
  assert.throws(
    () => env.writer().writeTransform((latest) => {
      n += 1;
      fs.writeFileSync(env.file, JSON.stringify({ model: `moved-${n}`, permissions: { allow: [] } }, null, 2) + '\n');
      return { changed: true, settings: { ...latest, permissions: { ...latest.permissions, defaultMode: 'plan' } } };
    }, { attempts: 3 }),
    (err) => err.code === SETTINGS_CONTENDED_CODE,
  );

  assert.equal(n, 3, 'it retried the configured number of times before giving up');
  assert.equal('defaultMode' in env.read().permissions, false,
    'and the losing write never landed');
});

test('an absent settings.json is the legitimate first run, not a refusal', (t) => {
  const env = tempSettings(t); // no file at all

  const out = env.writer().writeTransform((latest) => ({
    changed: true,
    settings: { ...latest, permissions: { ...latest?.permissions, defaultMode: 'bypassPermissions' } },
  }));

  assert.equal(out.wrote, true);
  assert.equal(env.read().permissions.defaultMode, 'bypassPermissions');
});


test('a transform that returns no settings object is refused, not written', (t) => {
  // JSON.stringify(undefined, null, 2) + '\n' is the ten bytes "undefined\n".
  // Without a shape guard, a transform returning { changed: true } and nothing
  // else atomically REPLACES settings.json with that and throws nothing — total
  // loss, no diagnostic. Same for a string, a number, or an array, which all
  // stringify to valid JSON of a shape Claude Code rejects.
  //
  // No current transform can do this. It is here because this writer is
  // documented as having none of writeAllow's protections, and until now its one
  // guard was the deny check, which no current transform can trip either.
  const shapes = [undefined, null, 'a string', 42, ['an', 'array']];
  for (const shape of shapes) {
    const env = tempSettings(t, { model: 'A', permissions: { allow: ['Bash(rg *)'] } });
    const before = fs.readFileSync(env.file, 'utf8');
    assert.throws(
      () => env.writer().writeTransform(() => ({ changed: true, settings: shape })),
      /no settings object/,
      `refused for ${JSON.stringify(shape) ?? 'undefined'}`,
    );
    assert.equal(fs.readFileSync(env.file, 'utf8'), before,
      `and nothing was written for ${JSON.stringify(shape) ?? 'undefined'}`);
  }
});

test('the transform input and the swap baseline are the SAME read', (t) => {
  // The subtle version of the bug this writer exists to fix. Originally `latest`
  // came from a readSettingsState() call and the CAS baseline from a second read
  // taken after it — so a write landing BETWEEN those two reads left the CAS
  // satisfied (its own before and after agreed) while the transform had already
  // been handed stale bytes, and the verbatim write discarded the concurrent
  // change.
  //
  // Reproduced by counting reads and mutating the file after the first one.
  const env = tempSettings(t, { model: 'A', permissions: { allow: [] } });
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function counted(target, ...rest) {
    const isSettings = typeof target === 'string' && target.endsWith('settings.json');
    if (isSettings) {
      reads += 1;
      // Land a concurrent write immediately after the writer's first read.
      if (reads === 1) {
        const out = realRead.call(this, target, ...rest);
        realRead.call(fs, target); // keep the handle warm; no behavioural need
        fs.writeFileSync(target, JSON.stringify(
          { model: 'B', effortLevel: 'high', permissions: { allow: [] } }, null, 2) + '\n');
        return out;
      }
    }
    return realRead.call(this, target, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  let seen = null;
  let threw = null;
  try {
    env.writer().writeTransform((latest) => {
      seen = latest;
      return { changed: true, settings: { ...latest, permissions: { ...latest.permissions, defaultMode: 'plan' } } };
    }, { attempts: 1 });
  } catch (err) { threw = err; }

  // Either outcome is correct, and both are safe. What must NOT happen is a
  // write that lands while `seen` is the pre-mutation object: that is the
  // two-reads-disagree bug.
  const disk = env.read();
  if (!threw && disk.permissions.defaultMode === 'plan') {
    assert.equal(seen.model, 'B',
      'if the write landed, the transform must have seen the newest bytes');
    assert.equal(disk.model, 'B', 'and the concurrent change survived');
    assert.equal(disk.effortLevel, 'high');
  } else {
    assert.equal(disk.model, 'B', 'the concurrent write was left intact');
    assert.equal('defaultMode' in disk.permissions, false, 'and the stale write was refused');
  }
});

test('a JSON scalar or array on disk is unreadable, not an empty object', (t) => {
  // `JSON.parse('[1,2]')` succeeds, so a naive parse hands the transform an
  // array and the write then produces a settings.json Claude Code cannot use.
  for (const body of ['[1, 2, 3]', '"a string"', '42', 'null']) {
    const env = tempSettings(t);
    fs.writeFileSync(env.file, body);
    assert.throws(
      () => env.writer().writeTransform((latest) => ({ changed: true, settings: latest })),
      (err) => err.code === SETTINGS_UNREADABLE_CODE,
      `refused for ${body}`,
    );
    assert.equal(fs.readFileSync(env.file, 'utf8'), body, `untouched for ${body}`);
  }
});

test('a file that VANISHES mid-transform is refused, not replaced with a stump', (t) => {
  // The worst input this writer can be handed, and it was live at HEAD until the
  // regressions audit found it. `absent -> {}` was treated as "the legitimate
  // first-run case" on EVERY attempt, including retries — where "the file existed
  // and is now gone" is not a first run. The preflight SETTINGS_UNREADABLE guard
  // runs once before the loop, so it could not see it.
  //
  // Reproduced end to end through the real verb: `--max on` against a 432-entry
  // file with one external delete landing inside the transform wrote a
  // settings.json holding 7 blanket entries and a hooks key — `model`,
  // `effortLevel`, `agentPushNotifEnabled` and all 432 entries gone — recorded an
  // EMPTY allow snapshot, and exited 0 reporting success. `--max off` then
  // "restored" nothing. On a CLI-only install there is no backup.
  const env = tempSettings(t, {
    model: 'claude-opus-5',
    effortLevel: 'high',
    permissions: { allow: ['Bash(git status *)', 'Bash(npm test *)'] },
  });

  let calls = 0;
  assert.throws(
    () => env.writer().writeTransform((latest) => {
      calls += 1;
      // The external actor deletes the file while the transform is running. On
      // attempt 1 this fails the compare-and-swap (bytes -> null) and retries;
      // attempt 2 is the one that used to see `{}` and write the stump.
      if (calls === 1) fs.rmSync(env.file);
      return { changed: true, settings: { ...latest, permissions: { allow: ['Bash(*)'] } } };
    }),
    (err) => {
      assert.match(err.message, /has since been deleted/);
      assert.equal(err.code, SETTINGS_CONTENDED_CODE);
      return true;
    },
  );

  // Once, not twice: attempt 1 ran the transform and lost the CAS, and attempt 2
  // refused on the READ, before calling it again. That ordering matters — the
  // transform has side effects (applyMax writes the allow snapshot), so refusing
  // ahead of it is what keeps the second attempt from taking a snapshot of {}.
  assert.equal(calls, 1, 'the refusal came from the read, ahead of a second transform');
  // The refusal must leave the file exactly as the external actor left it. A
  // stump here is the mutant: `{"permissions":{"allow":["Bash(*)"]}}`.
  assert.equal(fs.existsSync(env.file), false,
    'the writer materialised a stump over a file it had just seen with real content');
});

test('a first run really is still allowed to create the file', (t) => {
  // The other side of the vanish guard: `absent` on an attempt that has never
  // seen the file present is a genuine first run and must still work. Without
  // this, the fix above would break every fresh install — test/cli-hook.test.js
  // pins the CLI half, this pins the unit.
  const env = tempSettings(t);   // no second argument: the file is genuinely absent
  assert.equal(fs.existsSync(env.file), false, 'starting from no file at all');

  const out = env.writer().writeTransform((latest) => {
    assert.deepEqual(latest, {}, 'a first run sees {}');
    return { changed: true, settings: { permissions: { defaultMode: 'bypassPermissions' } } };
  });

  assert.equal(out.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(env.file, 'utf8')).permissions.defaultMode, 'bypassPermissions');
});

test('a MALFORMED deny is still refused, not silently dropped', (t) => {
  // `deniesLost` gated on Array.isArray, so a bare-string deny made `had` empty,
  // the guard answered "nothing lost", and the rule was written away with
  // `wrote: true`. A malformed deny is still the user's stated safety boundary,
  // and this writer's whole contract on that key is that it refuses to be the
  // thing that drops one.
  const env = tempSettings(t, {
    model: 'A',
    permissions: { allow: ['Bash(ls)'], deny: 'Bash(rm -rf *)' },
  });

  assert.throws(
    () => env.writer().writeTransform((latest) => ({
      changed: true,
      settings: { model: latest.model, permissions: { allow: latest.permissions.allow } },
    })),
    /would drop 1 deny rule\(s\).*non-array deny \(string\)/s,
  );

  const onDisk = JSON.parse(fs.readFileSync(env.file, 'utf8'));
  assert.equal(onDisk.permissions.deny, 'Bash(rm -rf *)', 'the malformed deny survived');
});

test('a transform that carries a malformed deny through is allowed', (t) => {
  // The guard must not become a blanket refusal for anyone with a malformed deny:
  // both production transforms spread `permissions` through, so they preserve it
  // by value and must still be able to write. Compared by value, not identity,
  // because a spread produces a new reference for the object case.
  const env = tempSettings(t, {
    permissions: { allow: ['Bash(ls)'], deny: { Bash: ['rm'] } },
  });

  const out = env.writer().writeTransform((latest) => ({
    changed: true,
    settings: { ...latest, permissions: { ...latest.permissions, defaultMode: 'plan' } },
  }));

  assert.equal(out.wrote, true, 'a value-preserving transform is not blocked');
  const onDisk = JSON.parse(fs.readFileSync(env.file, 'utf8'));
  assert.deepEqual(onDisk.permissions.deny, { Bash: ['rm'] });
  assert.equal(onDisk.permissions.defaultMode, 'plan');
});


test('writeAllow preserves a malformed deny instead of replacing it', (t) => {
  // A P0, reproduced by an audit. writeAllow's deny handling looked like a guard
  // and was the thing that destroyed the boundary: with `deny: "Bash(rm -rf *)"`
  // on disk and any non-empty denyAdditions, `latestDeny` came out `[]`, the
  // union produced the ADDITIONS ALONE, and the assignment replaced the string —
  // returning `{addedDeny: 1}`, i.e. reporting success.
  //
  // Without additions the string rode through on the spread, so the bug needed
  // the one caller that passes them: the extension's restoreFromBackup. Its own
  // Array.isArray check makes `missingDeny` the ENTIRE backup deny list exactly
  // when the live deny is a non-array, so the "Re-assert them" button on the
  // managed-policy prompt was the trigger — and the toast said
  // "restored from backup — +N allow, +M deny rules" while the boundary was gone.
  //
  // deniesLost() exists for this and is called only from writeTransform; its own
  // comment describes this defect verbatim.
  const env = tempSettings(t, {
    model: 'opus',
    permissions: { allow: ['Bash(ls)'], deny: 'Bash(rm -rf *)' },
  });

  const out = env.writer().writeAllow(env.read(), ['Bash(ls)', 'Bash(git *)'], ['Bash(curl *)']);

  const after = env.read();
  assert.equal(after.permissions.deny, 'Bash(rm -rf *)',
    'the user\u2019s stated safety boundary was replaced by the additions alone');
  assert.equal(out.addedDeny, 0,
    'nothing was added to a shape we cannot merge into, and saying otherwise is '
    + 'what made the restore toast a lie');
  // The allow half must still work — this is a preservation fix, not a refusal.
  assert.deepEqual(after.permissions.allow, ['Bash(ls)', 'Bash(git *)']);
  assert.equal(after.model, 'opus', 'and unrelated keys still ride through');
});

test('the two classifiers agree on every non-object JSON shape', (t) => {
  // readSettingsState and stateOfText each carried their own copy of the
  // classification and DISAGREED: stateOfText rejected a JSON scalar or array,
  // readSettingsState accepted it as PRESENT. A comment directly above claimed
  // they could not diverge. Measured consequences before the fix:
  //
  //   null                 -> writeAllow threw an UNCODED TypeError, so every
  //                           caller branching on SETTINGS_UNREADABLE_CODE missed
  //                           it and the extension surfaced
  //                           "write failed - Cannot read properties of null"
  //   "hello"              -> wrote {"0":"h","1":"e",...}
  //   ["Bash(rm -rf *)"]   -> wrote {"0":"Bash(rm -rf *)",...}
  //   42 / true            -> wrote {"permissions":{...}}
  //
  // Same shape as coverIndexKey/coverLookupKeys: two functions that must agree,
  // with nothing checking that they do. They are now one function, and this is
  // the check that was missing.
  for (const body of ['null', '"hello"', '["Bash(rm -rf *)"]', '42', 'true', '{ not json']) {
    const env = tempSettings(t);
    fs.writeFileSync(env.file, body);

    assert.equal(readSettingsState(env.file).state, SETTINGS_UNREADABLE,
      `${body} is not a settings object and must not classify as present`);

    // And the writer must REFUSE rather than crash or write garbage over it.
    assert.throws(() => env.writer().writeAllow({}, ['Bash(ls)']),
      (err) => {
        assert.equal(err.code, SETTINGS_UNREADABLE_CODE,
          `${body} must fail with a CODED refusal, not an uncoded TypeError`);
        return true;
      });
    assert.equal(fs.readFileSync(env.file, 'utf8'), body, `${body} is left untouched`);
  }
});

test('a settings.json that vanishes between reads is absent, but an unreadable one is not', (t) => {
  // stateOfText used fs.existsSync to tell "could not read" from "not there".
  // That is strictly WEAKER than the ENOENT check readSettingsState always had,
  // because existsSync returns false for ANY error — so an EMFILE under handle
  // exhaustion classified a present file as absent, handed the transform `{}`,
  // and the compare-and-swap then compared null against null and let a stump
  // through. Reproduced by an audit: a 10,445-byte / 431-entry settings.json
  // replaced by 64 bytes, wrote: true.
  const env = tempSettings(t);
  assert.equal(readSettingsState(env.file).state, SETTINGS_ABSENT,
    'a genuinely missing file is absent');

  // A directory at the path reads as EISDIR, not ENOENT — present but unusable.
  const dirEnv = tempSettings(t);
  fs.mkdirSync(dirEnv.file);
  assert.equal(readSettingsState(dirEnv.file).state, SETTINGS_UNREADABLE,
    'a non-ENOENT read error must never be classified as absent');

  // The case that actually distinguishes ENOENT from existsSync, simulated
  // because handle exhaustion cannot be produced on demand. Under EMFILE the
  // read fails AND existsSync returns false — existsSync returns false for ANY
  // error — so an existsSync classifier says "absent", hands the transform an
  // empty object, and the compare-and-swap then compares null against null and
  // lets a stump through. Without this the ENOENT preference has no killing
  // mutation: a directory trips EISDIR, but statSync succeeds there so
  // existsSync answers true and both spellings agree.
  const busy = tempSettings(t);
  const realRead = fs.readFileSync;
  const realExists = fs.existsSync;
  fs.readFileSync = (file, ...rest) => {
    if (file === busy.file) { const e = new Error('EMFILE'); e.code = 'EMFILE'; throw e; }
    return realRead(file, ...rest);
  };
  fs.existsSync = (file) => (file === busy.file ? false : realExists(file));
  try {
    assert.equal(readSettingsState(busy.file).state, SETTINGS_UNREADABLE,
      'EMFILE must classify as unreadable; existsSync answers false for every '
      + 'error, so classifying on it writes a stump over a file that exists');
  } finally {
    fs.readFileSync = realRead;
    fs.existsSync = realExists;
  }
});
