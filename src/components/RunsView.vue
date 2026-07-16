<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ActiveRun, RunEvent } from '../types/api'
import RunStatusTag from './RunStatusTag.vue'
import RunStatusReference from './RunStatusReference.vue'

const runs = ref<ActiveRun[]>([])
const selectedRunId = ref<string | null>(null)
const streams = ref<Record<string, { stdout: string; stderr: string }>>({})
const stoppingRunIds = ref(new Set<string>())
const triggerLabels = { manual: '手动', cron: '定时', retry: '重跑' } as const
const logElement = ref<HTMLElement | null>(null)
const latestSequences = new Map<string, number>()
const finishedRunIds = new Set<string>()
let unsubscribe: (() => void) | null = null
let mounted = false

/** Selects the first remaining run when the current selection finishes or disappears. */
function reconcileSelection() {
  if (!selectedRunId.value || !runs.value.some(run => run.id === selectedRunId.value)) selectedRunId.value = runs.value[0]?.id ?? null
}

/** Removes one completed run and its transient renderer state while retaining a sequence tombstone. */
function removeFinishedRun(runId: string) {
  runs.value = runs.value.filter(item => item.id !== runId)
  const nextStreams = { ...streams.value }
  delete nextStreams[runId]
  streams.value = nextStreams
  const nextStopping = new Set(stoppingRunIds.value)
  nextStopping.delete(runId)
  stoppingRunIds.value = nextStopping
  reconcileSelection()
}

/** Applies ordered run events, including runs that started after the snapshot and terminal tombstones for stale snapshots. */
function handleRunEvent(event: RunEvent) {
  const lastSequence = latestSequences.get(event.runId) ?? 0
  if (event.sequence <= lastSequence) return
  latestSequences.set(event.runId, event.sequence)
  if (event.type === 'finished') {
    finishedRunIds.add(event.runId)
    removeFinishedRun(event.runId)
  } else if (event.type === 'status' && event.record) {
    finishedRunIds.delete(event.runId)
    const index = runs.value.findIndex(item => item.id === event.runId)
    if (index < 0) runs.value = [...runs.value, event.record]
    else runs.value[index] = event.record
    reconcileSelection()
  } else if (event.type === 'stdout' || event.type === 'stderr') {
    const current = streams.value[event.runId] ?? { stdout: '', stderr: '' }
    streams.value = { ...streams.value, [event.runId]: { ...current, [event.type]: current[event.type] + event.chunk } }
    const run = runs.value.find(item => item.id === event.runId)
    if (run) run.sequence = event.sequence
  } else {
    const run = runs.value.find(item => item.id === event.runId)
    if (run) run.sequence = event.sequence
  }
  nextTick(() => { if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight })
}

/** Stops one active process tree and keeps the button locked until preload confirms a terminal record. */
async function stopRun(run: ActiveRun) {
  const api = window.scripty?.runs
  if (!api || stoppingRunIds.value.has(run.id)) return
  stoppingRunIds.value = new Set(stoppingRunIds.value).add(run.id)
  await api.stop(run.id)
  const next = new Set(stoppingRunIds.value)
  next.delete(run.id)
  stoppingRunIds.value = next
}

/** Subscribes before loading active runs and rejects snapshot rows superseded by newer events. */
async function initializeRuns() {
  const api = window.scripty?.runs
  if (!api) return
  mounted = true
  unsubscribe = api.subscribe(handleRunEvent)
  const result = await api.getActive()
  if (!mounted || result.ok === false) return
  const eventRuns = new Map(runs.value.map(run => [run.id, run]))
  for (const snapshot of result.data) {
    const latestSequence = latestSequences.get(snapshot.id) ?? 0
    if (finishedRunIds.has(snapshot.id) || snapshot.sequence < latestSequence) continue
    eventRuns.set(snapshot.id, snapshot)
    latestSequences.set(snapshot.id, Math.max(latestSequence, snapshot.sequence))
  }
  runs.value = [...eventRuns.values()].filter(run => !finishedRunIds.has(run.id))
  reconcileSelection()
}

onMounted(initializeRuns)
onBeforeUnmount(() => { mounted = false; unsubscribe?.(); unsubscribe = null })
</script>

<template>
  <section class="runs-view" aria-labelledby="runs-heading">
    <div class="section-heading"><div><h2 id="runs-heading">运行中任务</h2></div><ZTag type="info">{{ runs.length }} 个运行</ZTag></div>
    <RunStatusReference />
    <div v-if="runs.length === 0" class="empty-state"><div class="empty-state__mark">R</div><h3>当前没有运行中的任务</h3><p>从任务库启动任务后，可在这里查看实时输出。</p></div>
    <div v-else class="live-runs">
      <div class="run-summary" v-for="run in runs" :key="run.id">
        <strong>{{ run.taskNameSnapshot }}</strong>
        <RunStatusTag :status="run.status" />
        <ZTag type="info" size="small">{{ triggerLabels[run.trigger] }}</ZTag>
        <span>PID {{ run.pid }}</span>
        <ZButton type="danger" size="small" :loading="stoppingRunIds.has(run.id)" @click="stopRun(run)">停止</ZButton>
      </div>
      <ZSelect v-model="selectedRunId" :options="runs.map(run => ({ label: run.taskNameSnapshot, value: run.id }))" />
      <ZTabs default-value="stdout" type="segment">
        <ZTabPane name="stdout" tab="stdout"><pre ref="logElement" class="live-log">{{ streams[selectedRunId ?? '']?.stdout ?? '' }}</pre></ZTabPane>
        <ZTabPane name="stderr" tab="stderr"><pre class="live-log live-log--error">{{ streams[selectedRunId ?? '']?.stderr ?? '' }}</pre></ZTabPane>
      </ZTabs>
    </div>
  </section>
</template>

<style scoped lang="scss">
.runs-view {
  padding-top: 0;
}

.run-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--card-bg);
}

.run-summary span:nth-last-child(2) {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 12px;
}

.live-runs {
  display: grid;
  gap: 18px;
}

.live-log {
  min-height: 320px;
  max-height: 480px;
  margin: 0;
  padding: 16px;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--card-bg);
  color: var(--text-color);
  font: 13px/1.6 "SFMono-Regular", Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.live-log--error {
  color: var(--error-color);
}
</style>
