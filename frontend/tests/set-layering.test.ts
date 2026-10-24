import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeLayering } from '../src/set-package.ts'

const SCENE = { project_id: '01a15eca-3070-77da-b438-65d2ab20408a', revision_id: '01a16c15-63a0-7b5b-baa2-aa7934a196b3', material_key: 'anxi_street', state_key: 'dawn', label: '清晨自然光' }
const WORLD = { asset_id: '01a16900-0000-7000-8000-000000000001', version_id: '01a16900-0000-7000-8000-000000000002', label: '安喜县临河街区 v2' }

test('v1.0 packages default to a setup without lineage or cast', () => {
  const r = normalizeLayering({ schema_version: '1.0' })
  assert.equal(r.kind, 'setup')
  assert.deepEqual(r.lineage, {})
  assert.deepEqual(r.cast, [])
})

test('v1.1 setup package exposes the three-segment lineage and cast', () => {
  const r = normalizeLayering({
    kind: 'setup',
    lineage: { world_asset: WORLD, project_scene: SCENE, setup: { setup_key: 's03', label: 'S03 马桩鞭打督邮' } },
    cast: [{ node_prefix: 'ACTOR_zhangfei', character_key: 'zhangfei', label: '张飞', wardrobe_label: '黑袍 · 干净' }],
  })
  assert.equal(r.lineage.world_asset?.id, WORLD.asset_id)
  assert.equal(r.lineage.project_scene?.version_id, SCENE.revision_id)
  assert.equal(r.lineage.project_scene?.state_key, 'dawn')
  assert.equal(r.lineage.setup?.setup_key, 's03')
  assert.equal(r.cast[0].label, '张飞')
})

test('empty-set packages reject actors and mismatched lineage', () => {
  assert.throws(() => normalizeLayering({ kind: 'world_empty', cast: [{ node_prefix: 'ACTOR_a' }] }), /EMPTY_SET_HAS_ACTORS/)
  assert.throws(() => normalizeLayering({ kind: 'project_state', object_groups: [{ prefix: 'ACTOR_', label: '替身' }] }), /EMPTY_SET_HAS_ACTORS/)
  assert.throws(() => normalizeLayering({ kind: 'world_empty', lineage: { world_asset: WORLD, project_scene: SCENE } }), /world_asset/)
  assert.throws(() => normalizeLayering({ kind: 'setup', lineage: { project_scene: SCENE } }), /setup/)
  assert.throws(() => normalizeLayering({ kind: 'stage' }), /kind/)
})

test('cast prefixes must be unique ACTOR_ node prefixes', () => {
  assert.throws(() => normalizeLayering({ kind: 'setup', cast: [{ node_prefix: 'zhangfei' }] }), /node_prefix/)
  assert.throws(() => normalizeLayering({ kind: 'setup', cast: [{ node_prefix: 'ACTOR_a' }, { node_prefix: 'ACTOR_a' }] }), /node_prefix/)
})
