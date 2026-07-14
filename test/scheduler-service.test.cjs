'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { CLOCK_RECHECK_INTERVAL_MS, MAX_TIMER_DELAY_MS, createSchedulerService, registerSchedulerLifecycle } = require('../public/preload/scheduler-service')

/** Creates a deterministic clock whose scheduled callbacks run only when tests advance time. */
function createFakeClock(start) {
  let nowMs = Date.parse(start)
  let nextId = 1
  const pending = new Map()
  return {
    now: () => new Date(nowMs),
    setTimeout(callback, delay) {
      const id = nextId++
      pending.set(id, { callback, delay, at: nowMs + delay })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    advance(ms) { nowMs += ms },
    set(value) { nowMs = typeof value === 'number' ? value : Date.parse(value) },
    run(id) { const timer = pending.get(id); pending.delete(id); timer?.callback() },
    pending
  }
}

/** Creates a persisted-task-shaped scheduler input with safe defaults. */
function task(id, overrides = {}) {
  return { id, enabled: true, cron: '* * * * *', ...overrides }
}

/** Creates a scheduler attached to the fake clock and records private Cron starts. */
function fixture(start = '2026-07-12T00:00:10.000Z') {
  const clock = createFakeClock(start)
  const starts = []
  const scheduler = createSchedulerService({
    startScheduledRun: async id => { starts.push(id) },
    now: clock.now,
    getTimezone: () => ({ timeZone: 'UTC', offsetMinutes: 0 }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  })
  return { clock, scheduler, starts }
}

test('publishes only real scheduler status transitions and supports safe unsubscribe', () => {
  const { scheduler } = fixture()
  const values = []
  const unsubscribe = scheduler.subscribe(value => values.push(value))
  scheduler.subscribe(() => { throw new Error('listener failure') })
  scheduler.initialize([])
  const first = scheduler.prepareTask(task('one')); scheduler.commit(first)
  const replacement = scheduler.prepareTask(task('one', { cron: '0 * * * *' })); scheduler.commit(replacement)
  scheduler.commit(scheduler.prepareTask(task('one', { enabled: false })))
  unsubscribe()
  scheduler.shutdown()
  assert.deepEqual(values, ['unavailable', 'inactive', 'active', 'inactive'])
})

test('initializes only enabled Cron tasks and exposes committed next run times', () => {
  const { clock, scheduler } = fixture()
  scheduler.initialize([task('active'), task('disabled', { enabled: false }), task('manual', { cron: null })])
  assert.equal(scheduler.getStatus(), 'active')
  assert.equal(scheduler.getNextRunAt('active'), '2026-07-12T00:01:00.000Z')
  assert.equal(scheduler.getNextRunAt('disabled'), null)
  assert.equal(clock.pending.size, 1)
  scheduler.shutdown()
})

test('hot updates one task and abort keeps its previous schedule intact', () => {
  const { clock, scheduler } = fixture()
  scheduler.initialize([task('one'), task('two')])
  const oldOne = scheduler.getNextRunAt('one')
  const oldTwo = scheduler.getNextRunAt('two')
  const candidate = scheduler.prepareTask(task('one', { cron: '0 * * * *' }))
  assert.equal(scheduler.getNextRunAt('one'), oldOne)
  scheduler.abort(candidate)
  assert.equal(scheduler.getNextRunAt('one'), oldOne)
  assert.equal(scheduler.getNextRunAt('two'), oldTwo)

  const committed = scheduler.prepareTask(task('one', { cron: '0 * * * *' }))
  scheduler.commit(committed)
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T01:00:00.000Z')
  assert.equal(scheduler.getNextRunAt('two'), oldTwo)
  assert.equal(clock.pending.size, 2)
  scheduler.shutdown()
})

test('disable and removal cancel only the committed task schedule', () => {
  const { scheduler } = fixture()
  scheduler.initialize([task('one'), task('two')])
  scheduler.commit(scheduler.prepareTask(task('one', { enabled: false })))
  assert.equal(scheduler.getNextRunAt('one'), null)
  assert.ok(scheduler.getNextRunAt('two'))
  scheduler.commit(scheduler.prepareRemoval('two'))
  assert.equal(scheduler.getStatus(), 'inactive')
  scheduler.shutdown()
})

test('an elapsed timer schedules the next occurrence before starting a Cron run', async () => {
  const { clock, scheduler, starts } = fixture()
  scheduler.initialize([task('one')])
  const [timerId] = clock.pending.keys()
  clock.advance(50000)
  clock.run(timerId)
  await Promise.resolve()
  assert.deepEqual(starts, ['one'])
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T00:02:00.000Z')
  assert.equal(clock.pending.size, 1)
  scheduler.shutdown()
})

test('sleep recovery triggers at most once and jumps directly to the next future occurrence', async () => {
  const { clock, scheduler, starts } = fixture()
  scheduler.initialize([task('one')])
  const [timerId] = clock.pending.keys()
  clock.set('2026-07-12T05:30:45.000Z')
  clock.run(timerId)
  await Promise.resolve()
  assert.deepEqual(starts, ['one'])
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T05:31:00.000Z')
  assert.equal(clock.pending.size, 1)
  scheduler.shutdown()
})

test('backward clock movement never runs early and reconciles to the first future occurrence', () => {
  const { clock, scheduler, starts } = fixture('2026-07-12T00:00:50.000Z')
  scheduler.initialize([task('one')])
  const [timerId] = clock.pending.keys()
  clock.set('2026-07-11T23:59:30.000Z')
  clock.run(timerId)
  assert.deepEqual(starts, [])
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T00:00:00.000Z')
  assert.equal(clock.pending.size, 1)
  scheduler.shutdown()
})

test('duplicate callbacks and clock rollback cannot replay the same scheduled occurrence', async () => {
  const { clock, scheduler, starts } = fixture('2026-07-12T00:00:50.000Z')
  scheduler.initialize([task('one')])
  const [timerId, timer] = clock.pending.entries().next().value
  clock.set('2026-07-12T00:01:00.000Z')
  clock.run(timerId)
  timer.callback()
  await Promise.resolve()
  assert.deepEqual(starts, ['one'])

  clock.set('2026-07-12T00:00:50.000Z')
  const change = scheduler.prepareTask(task('one'))
  scheduler.commit(change)
  const replayId = Array.from(clock.pending.keys()).at(-1)
  clock.set('2026-07-12T00:01:00.000Z')
  clock.run(replayId)
  await Promise.resolve()
  assert.deepEqual(starts, ['one'])
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T00:02:00.000Z')
  scheduler.shutdown()
})

test('timezone changes discard the old target and recalculate without running it', () => {
  const clock = createFakeClock('2026-07-12T00:00:10.000Z')
  let timezone = { timeZone: 'UTC', offsetMinutes: 0 }
  const starts = []
  const scheduler = createSchedulerService({
    startScheduledRun: async id => starts.push(id), now: clock.now,
    getTimezone: () => timezone, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  })
  scheduler.initialize([task('daily', { cron: '0 9 * * *' })])
  const [timerId, timer] = clock.pending.entries().next().value
  assert.equal(timer.delay, CLOCK_RECHECK_INTERVAL_MS)
  timezone = { timeZone: 'Asia/Shanghai', offsetMinutes: -480 }
  clock.run(timerId)
  assert.deepEqual(starts, [])
  assert.equal(scheduler.getNextRunAt('daily'), '2026-07-12T01:00:00.000Z')
  scheduler.shutdown()
})

test('a prepared timer consumed before commit is rebuilt as a future schedule', () => {
  const { clock, scheduler, starts } = fixture('2026-07-12T00:00:50.000Z')
  scheduler.initialize([])
  const change = scheduler.prepareTask(task('one'))
  const [timerId] = clock.pending.keys()
  clock.set('2026-07-12T00:01:00.000Z')
  clock.run(timerId)
  assert.deepEqual(starts, [])
  scheduler.commit(change)
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T00:02:00.000Z')
  assert.equal(clock.pending.size, 1)
  scheduler.shutdown()
})

test('a concurrency-rejected scheduled start does not break the next Cron plan', async () => {
  const clock = createFakeClock('2026-07-12T00:00:50.000Z')
  const attempts = []
  const scheduler = createSchedulerService({
    startScheduledRun: async id => { attempts.push(id); return { ok: false, error: { code: 'RUN_ALREADY_ACTIVE' } } },
    now: clock.now, getTimezone: () => ({ timeZone: 'UTC', offsetMinutes: 0 }),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
  })
  scheduler.initialize([task('one')])
  const [timerId] = clock.pending.keys()
  clock.set('2026-07-12T00:01:00.000Z')
  clock.run(timerId)
  await Promise.resolve()
  assert.deepEqual(attempts, ['one'])
  assert.equal(scheduler.getNextRunAt('one'), '2026-07-12T00:02:00.000Z')
  assert.equal(clock.pending.size, 1)
  scheduler.shutdown()
})

test('long waits are clamped and cannot execute before their target instant', () => {
  const clock = createFakeClock('2026-01-01T00:00:00.000Z')
  let starts = 0
  const scheduler = createSchedulerService({
    startScheduledRun: async () => { starts += 1 }, now: clock.now,
    getTimezone: () => ({ timeZone: 'UTC', offsetMinutes: 0 }),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    clockRecheckIntervalMs: MAX_TIMER_DELAY_MS + 1
  })
  scheduler.initialize([task('monthly', { cron: '0 0 1 3 *' })])
  let [timerId, timer] = clock.pending.entries().next().value
  assert.equal(timer.delay, MAX_TIMER_DELAY_MS)
  clock.advance(MAX_TIMER_DELAY_MS)
  clock.run(timerId)
  assert.equal(starts, 0)
  ;[timerId, timer] = clock.pending.entries().next().value
  assert.ok(timer.delay > 0)
  scheduler.shutdown()
})

test('lifecycle ignores background exits and permanently shuts down on process exit', () => {
  const { clock, scheduler } = fixture()
  scheduler.initialize([task('one')])
  let onOut
  registerSchedulerLifecycle({ onPluginOut(callback) { onOut = callback } }, scheduler)
  onOut(false)
  assert.equal(scheduler.getStatus(), 'active')
  assert.equal(clock.pending.size, 1)
  onOut(true)
  assert.equal(scheduler.getStatus(), 'unavailable')
  assert.equal(clock.pending.size, 0)
  onOut(true)
})
