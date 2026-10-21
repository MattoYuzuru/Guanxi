import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_DEVICE_CODES } from '../../src/federation/enrollment.ts'
import { SimNode, identity } from './harness.ts'

test('device code allocation requires JSON Content-Type before unauthenticated mutation', async () => {
  const home = new SimNode(identity('home')); const device = identity('device')
  try {
    const body = JSON.stringify({publicKey:device.identity.publicKey})
    for (const headers of [new Headers(), new Headers({'Content-Type':'text/plain'}), new Headers({'Content-Type':'application/x-www-form-urlencoded'})]) {
      const response = await home.app.request('http://node/api/federation/device/code', {method:'POST',headers,body})
      assert.equal(response.status, 415, 'simple POST cannot allocate a bootstrap code')
      assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_devices').get()!.n, 0)
    }
    const response = await home.app.request('http://node/api/federation/device/code', {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body})
    assert.equal(response.status, 200)
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_devices').get()!.n, 1)
  } finally { home.close() }
})

test('device code storage is bounded and expired requests are purged before allocation', async () => {
  const home = new SimNode(identity('home')); const device = identity('device')
  try {
    for (let i=0; i<MAX_DEVICE_CODES; i++) home.federation.enrollment.begin(device.identity.publicKey)
    const allocate = () => home.app.request('http://node/api/federation/device/code', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicKey:device.identity.publicKey})})
    assert.equal((await allocate()).status, 429, 'unexpired bootstrap storage is bounded')
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_devices').get()!.n, MAX_DEVICE_CODES)
    home.time += 600_001
    assert.equal((await allocate()).status, 200, 'expired codes free the budget')
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_devices').get()!.n, 1, 'expired rows were purged')
  } finally { home.close() }
})

test('GET telemetry returns only samples owned by the caller account', async () => {
  const home = new SimNode(identity('home')); const owner = new SimNode(identity('owner-node')); const family = new SimNode(identity('family-node',{accountId:'family'}))
  try {
    for (const peer of [owner,family]) {
      home.trust(peer); peer.trust(home)
      assert.equal((await peer.request(home,'POST','/telemetry', {nodeId:peer.keys.identity.id,source:'test',observedAt:peer.time,confidence:'reported',memoryPressure:'unknown',cpuUtilization:null,ownerPresent:true})).status, 200)
    }
    for (const peer of [owner,family]) {
      const response = await peer.request(home,'GET','/telemetry')
      assert.equal(response.status, 200)
      const {samples} = await response.json() as {samples:{nodeId:string}[]}
      assert.deepEqual(samples.map((s)=>s.nodeId), [peer.keys.identity.id], 'other-account owner presence is private')
    }
  } finally { home.close(); owner.close(); family.close() }
})
