'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createAppApi } = require('../public/preload/app-service')

/** Creates a scheduler stub with observable status subscription and cleanup. */
function fixture(status = 'inactive') {
  let listener
  let unsubscribed = false
  const scheduler = {
    getStatus() { return status },
    subscribe(callback) { listener = callback; callback(status); return () => { unsubscribed = true } }
  }
  return { scheduler, emit: value => listener?.(value), wasUnsubscribed: () => unsubscribed }
}

test('returns scheduler status through the standard Result envelope', async () => {
  const { scheduler } = fixture('active')
  const result = await createAppApi(scheduler).getSchedulerStatus()
  assert.equal(result.ok, true)
  assert.equal(result.data, 'active')
  assert.match(result.requestId, /^[0-9a-f-]{36}$/)
})

test('forwards scheduler status subscriptions and their cleanup callback', () => {
  const source = fixture()
  const values = []
  const unsubscribe = createAppApi(source.scheduler).subscribeSchedulerStatus(value => values.push(value))
  source.emit('active')
  unsubscribe()
  assert.deepEqual(values, ['inactive', 'active'])
  assert.equal(source.wasUnsubscribed(), true)
})

test('maps scheduler getter failures without exposing the thrown error', async () => {
  const api = createAppApi({ getStatus() { throw new Error('internal details') }, subscribe() { return () => {} } })
  const result = await api.getSchedulerStatus()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.equal(result.error.message.includes('internal details'), false)
})
