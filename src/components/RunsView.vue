<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ActiveRun, RunEvent } from '../types/api'
import RunStatusTag from './RunStatusTag.vue'
import RunStatusReference from './RunStatusReference.vue'
import { ZDrawer, ZDrawerContent } from 'ztools-ui'

interface LogEntry {
  timestamp: string
  type: 'stdout' | 'stderr'
  content: string
}

const runs = ref<ActiveRun[]>([])
const selectedRunId = ref<string | null>(null)
const logs = ref<Record<string, LogEntry[]>>({})
const stoppingRunIds = ref(new Set<string>())
const triggerLabels = { manual: '手动', cron: '定时', retry: '重跑' } as const
const logElement = ref<HTMLElement | null>(null)
const latestSequences = new Map<string, number>()
const finishedRunIds = new Set<string>()
const drawerVisible = ref(false)
const drawerRunId = ref<string | null>(null)
const logsPaused = ref(false)
let unsubscribe: (() => void) | null = null
let mounted = false

/** Selects the first remaining run when the current selection finishes or disappears. */
function reconcileSelection() {
  if (!selectedRunId.value || !runs.value.some(run => run.id === selectedRunId.value)) selectedRunId.value = runs.value[0]?.id ?? null
}

/** Removes one completed run and its transient renderer state while retaining a sequence tombstone. */
function removeFinishedRun(runId: string) {
  runs.value = runs.value.filter(item => item.id !== runId)
  const nextLogs = { ...logs.value }
  delete nextLogs[runId]
  logs.value = nextLogs
  const nextStopping = new Set(stoppingRunIds.value)
  nextStopping.delete(runId)
  stoppingRunIds.value = nextStopping
  reconcileSelection()
}

/** Opens the log drawer for a specific run */
function viewLogs(runId: string) {
  drawerRunId.value = runId
  drawerVisible.value = true
  logsPaused.value = false
}

/** Toggles log updates pause state */
function toggleLogsPause() {
  logsPaused.value = !logsPaused.value
  if (!logsPaused.value) {
    // Resume and scroll to bottom
    nextTick(() => { if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight })
  }
}

/** Formats timestamp for display */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
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
    const current = logs.value[event.runId] ?? []
    const newEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      type: event.type,
      content: event.chunk
    }
    logs.value = { ...logs.value, [event.runId]: [...current, newEntry] }
    const run = runs.value.find(item => item.id === event.runId)
    if (run) run.sequence = event.sequence
    if (!logsPaused.value) {
      nextTick(() => { if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight })
    }
  } else {
    const run = runs.value.find(item => item.id === event.runId)
    if (run) run.sequence = event.sequence
  }
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
        <ZButton type="primary" size="small" @click="viewLogs(run.id)">查看日志</ZButton>
        <ZButton type="danger" size="small" :loading="stoppingRunIds.has(run.id)" @click="stopRun(run)">停止</ZButton>
      </div>
    </div>

    <ZDrawer v-model:show="drawerVisible" placement="right" width="800px" :mask-closable="true">
      <ZDrawerContent :title="`任务日志 - ${runs.find(r => r.id === drawerRunId)?.taskNameSnapshot ?? ''}`" closable :body-content-style="{ height: '100%', display: 'flex', flexDirection: 'column', padding: '24px' }">
        <div v-if="drawerRunId && logs[drawerRunId]" class="log-viewer">
          <div class="log-header">
            <span class="log-stats">共 {{ logs[drawerRunId].length }} 条记录</span>
            <ZButton type="default" size="small" @click="toggleLogsPause">
              {{ logsPaused ? '继续跟随' : '暂停跟随' }}
            </ZButton>
          </div>
          <div ref="logElement" class="log-entries">
            <div v-for="(entry, index) in logs[drawerRunId]" :key="index" class="log-entry" :class="`log-entry--${entry.type}`">
              <pre class="log-content">{{ formatTime(entry.timestamp) }} [{{ entry.type === 'stdout' ? 'stdout' : 'stderr' }}] {{ entry.content }}</pre>
            </div>
          </div>
        </div>
        <div v-else class="log-empty">
          <p>暂无日志记录</p>
        </div>
      </ZDrawerContent>
    </ZDrawer>
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

.run-summary span:nth-last-child(3) {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 12px;
}

.live-runs {
  display: grid;
  gap: 18px;
}

.log-viewer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.log-stats {
  font-size: 13px;
  color: var(--text-secondary);
}

.log-entries {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-bg);
}

.log-entry {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
  transition: background 0.2s;

  &:hover {
    background: var(--hover-bg);
  }

  &:last-child {
    border-bottom: none;
  }
}

.log-content {
  margin: 0;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-color);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.log-entry--stderr .log-content {
  color: var(--error-color);
}

.log-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 400px;
  color: var(--text-secondary);
}
</style>
