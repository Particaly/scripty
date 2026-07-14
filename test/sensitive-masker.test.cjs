'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { MASK, SensitiveStreamMasker, maskSensitiveValues } = require('../public/preload/sensitive-masker')

test('masks all known non-empty values longest-first', () => {
  assert.equal(maskSensitiveValues('token=abcdef short=abc', ['abc', 'abcdef', '']), `token=${MASK} short=${MASK}`)
})

test('masks a sensitive value split across stream chunks before emitting its line', () => {
  const masker = new SensitiveStreamMasker(['super-secret'])
  assert.equal(masker.push('token=super-'), '')
  assert.equal(masker.push('secret\nnext='), `token=${MASK}\n`)
  assert.equal(masker.flush(), 'next=')
})
