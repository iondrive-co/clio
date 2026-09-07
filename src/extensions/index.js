
import agents from '../agents/index.js';
import ssh from '../ssh/index.js';
import scripts from '../scripts/index.js';

const ADAPTERS = [...agents, ...ssh, ...scripts];

const CAPTURE_INTERVAL_MS = 8000;

const ADOPT_GRACE_MS = 60000;

const SEP = ':';

function adapterFor(record) {
  return record?.kind ? ADAPTERS.find((a) => a.id === record.kind) || null : null;
}

function running(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sameState(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function shellQuote(argv) {
  return argv
    .map((arg) => {
      const word = String(arg);
      return /^[\w.:/=@,+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

export function extensionToState(record) {
  if (!record?.kind) return null;
  return { kind: record.kind, state: record.state ?? null, seenAt: record.seenAt ?? null };
}

export function extensionFromState(saved, { pid = null, resumedAt = null } = {}) {
  if (!saved?.kind || !ADAPTERS.some((a) => a.id === saved.kind)) return null;
  return {
    kind: saved.kind,
    state: saved.state ?? null,
    seenAt: saved.seenAt ?? null,
    capturedAt: 0,
    pid,
    resumedAt,
  };
}

export function extensionIdentity(record) {
  const adapter = adapterFor(record);
  if (!adapter?.identify) return null;
  const id = safely(() => adapter.identify(record.state || {}), null);
  return id ? `${adapter.id}${SEP}${id}` : null;
}

export function observeExtension(record, { foreground = null, taken = new Set(), title = null, now = Date.now() } = {}) {
  const adapter = foreground ? ADAPTERS.find((a) => safely(() => a.matches(foreground), false)) : null;

  if (adapter) {
    const known = record?.kind === adapter.id && record.pid === foreground.pid;
    if (known && now - (record.capturedAt || 0) < CAPTURE_INTERVAL_MS) return { record, changed: false };

    const state = safely(
      () =>
        adapter.capture({
          ...foreground,
          previous: known ? record.state : null,
          taken: claims(adapter, taken),
          title,
        }),
      known ? record.state : null,
    );

    return {
      record: {
        kind: adapter.id,
        state: state ?? null,
        seenAt: now,
        capturedAt: now,
        pid: foreground.pid,
        resumedAt: null,
        activity: known ? record.activity ?? null : null,
      },
      changed: !known || !sameState(record.state, state),
    };
  }

  if (!record) return { record: null, changed: false };
  if (record.pid && running(record.pid)) return { record, changed: false };
  if (!record.pid && record.resumedAt && now - record.resumedAt < ADOPT_GRACE_MS) {
    return { record, changed: false };
  }
  return { record: null, changed: true };
}

function claims(adapter, taken) {
  const prefix = `${adapter.id}${SEP}`;
  const claimed = new Set();
  for (const entry of taken) {
    if (entry.startsWith(prefix)) claimed.add(entry.slice(prefix.length));
  }
  return claimed;
}

export function observeAttention(record, { termTitle = null, titleAt = 0, now = Date.now() } = {}) {
  const adapter = adapterFor(record);
  if (!adapter?.activity) return null;

  const answer = safely(() => adapter.activity(record.state || {}, { termTitle, titleAt, now }), null);
  if ((answer !== 'working' && answer !== 'waiting') || answer === record.activity) return null;

  const was = record.activity;
  record.activity = answer;
  return answer === 'waiting' && was !== 'working' ? null : answer;
}

export function resumeExtension(record, { cwd = null } = {}) {
  const adapter = adapterFor(record);
  if (!adapter) return null;

  const plan = safely(() => adapter.resume(record.state || {}, { cwd }), null);
  if (!plan?.argv?.length) return null;

  return {
    kind: adapter.id,
    command: shellQuote(plan.argv),
    why: plan.why || `resuming ${adapter.name}`,
    run: plan.run !== false,
    alone: plan.alone === true,
  };
}

export function recoverExtension({ command = null, cwd = null } = {}) {
  if (!command) return null;
  for (const adapter of ADAPTERS) {
    if (!adapter.recover) continue;
    const state = safely(() => adapter.recover({ command, cwd }), null);
    if (!state) continue;
    const plan = safely(() => adapter.resume(state, { cwd }), null);
    if (!plan?.argv?.length) continue;
    return { kind: adapter.id, command: shellQuote(plan.argv) };
  }
  return null;
}

export function describeExtension(record) {
  const adapter = adapterFor(record);
  if (!adapter) return null;
  return safely(() => adapter.describe(record.state || {}), adapter.name) || adapter.name;
}

export function extensionTitle(record) {
  const adapter = adapterFor(record);
  if (!adapter?.title) return null;
  const title = safely(() => adapter.title(record.state || {}), null);
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null;
}

function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
