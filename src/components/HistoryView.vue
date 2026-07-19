<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LogChunk, RunEvent } from '../types/api'
import type { RunRecord, RunStatus, RunTrigger } from '../types/domain'
import RunStatusTag from './RunStatusTag.vue'

interface ActiveLogEntry {
  timestamp: string
  type: 'stdout' | 'stderr'
  content: string
}

interface LogLine {
  time: string
  type: 'stdout' | 'stderr'
  content: string
}

const props = defineProps<{
  requestConfirmation: (options: { title: string; message: string; type?: 'info' | 'warning' | 'danger'; confirmText?: string; cancelText?: string }) => Promise<boolean>
}>()
const emit = defineEmits<{ (event: 'feedback', type: 'success' | 'error', message: string): void }>()
const records = ref<RunRecord[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const search = ref('')
const status = ref<RunStatus | 'all'>('all')
const trigger = ref<RunTrigger | 'all'>('all')
const loading = ref(false)
const detailVisible = ref(false)
const selected = ref<RunRecord | null>(null)
/** Whether the open detail streams a live run ('live') or reads a persisted log ('persisted'). */
const detailMode = ref<'live' | 'persisted' | null>(null)
const log = ref<LogChunk | null>(null)
const logContent = ref('')
const logLoading = ref(false)
const retryingId = ref<string | null>(null)
const cleaning = ref(false)
const triggerLabels = { manual: '手动', cron: '定时', retry: '重跑' } as const
const statusOptions = [
  { label: '全部状态', value: 'all' }, { label: '成功', value: 'success' }, { label: '失败', value: 'failed' },
  { label: '超时', value: 'timed_out' }, { label: '已停止', value: 'stopped' }, { label: '异常中断', value: 'interrupted' }
]
const triggerOptions = [{ label: '全部来源', value: 'all' }, { label: '手动', value: 'manual' }, { label: '定时', value: 'cron' }, { label: '重跑', value: 'retry' }]
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

/** Run ids known to be active, kept reactive so cards and the detail drawer reflect live state. */
const activeRunIds = ref(new Set<string>())
/** Live log buffers for active runs, capped at ~1 MiB each; released on finish unless a live detail holds them. */
const activeLogs = ref<Record<string, ActiveLogEntry[]>>({})
const stoppingRunIds = ref(new Set<string>())
/** Highest sequence seen per run, so stale events from a superseded snapshot are ignored. */
const activeRunSequences = new Map<string, number>()

/** Formats an ISO timestamp as `hh:mm:ss` local time for the live log meta column. */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** True when the open detail is streaming a live run rather than reading a persisted log. */
const isLiveDetail = computed(() => detailMode.value === 'live')

/** Splits the persisted log buffer into `[hh:mm:ss] [type]` meta plus content entries, anchoring on the persisted line prefix. */
const logEntries = computed<LogLine[]>(() => {
  const text = logContent.value
  if (!text) return []
  const prefix = /(?:^|\n)\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}) \[(stdout|stderr)\] /g
  const matches = [...text.matchAll(prefix)]
  return matches.map((match, index) => {
    const contentStart = match.index! + match[0].length
    const contentEnd = index + 1 < matches.length ? matches[index + 1].index! : text.length
    return { time: match[1], type: match[2] as 'stdout' | 'stderr', content: text.slice(contentStart, contentEnd).replace(/\n$/, '') }
  })
})

/** Live log entries for the open run, reversed so the newest output stays pinned to the top. */
const liveLogEntries = computed<LogLine[]>(() => {
  if (detailMode.value !== 'live' || !selected.value) return []
  const entries = activeLogs.value[selected.value.id] ?? []
  return [...entries].reverse().map(entry => ({ time: formatTime(entry.timestamp), type: entry.type, content: entry.content }))
})

/** Entries rendered in the detail log grid, switching between live and persisted sources. */
const visibleLogEntries = computed<LogLine[]>(() =>
  detailMode.value === 'live' ? liveLogEntries.value : logEntries.value
)

let historyRequestSequence = 0
let unsubscribeRuns: (() => void) | null = null
let mounted = false

/** Loads one filtered page and allows only the newest request to replace the visible history snapshot. */
async function loadHistory() {
  const requestSequence = ++historyRequestSequence
  loading.value = true
  const activeStatus = status.value && status.value !== 'all' ? status.value : undefined
  const activeTrigger = trigger.value && trigger.value !== 'all' ? trigger.value : undefined
  const result = await window.scripty?.history?.list({ page: page.value, pageSize, search: search.value || undefined, status: activeStatus, trigger: activeTrigger })
  if (!mounted || requestSequence !== historyRequestSequence) return
  loading.value = false
  if (result?.ok === true) {
    records.value = result.data.items
    total.value = result.data.total
  } else if (result?.ok === false) emit('feedback', 'error', result.error.message)
}

/** Opens one run detail; active runs stream live reverse logs, terminal runs read persisted chunks. */
async function openDetail(record: RunRecord) {
  const detail = await window.scripty.history.get(record.id)
  if (detail.ok === false) return emit('feedback', 'error', detail.error.message)
  selected.value = detail.data
  detailMode.value = activeRunIds.value.has(record.id) ? 'live' : 'persisted'
  detailVisible.value = true
  logContent.value = ''
  log.value = null
  if (detailMode.value === 'persisted') await loadNextLogChunk()
}

/** Appends one bounded 64 KiB persisted log chunk while capping renderer memory at 1 MiB. */
async function loadNextLogChunk() {
  if (!selected.value || logLoading.value || log.value?.end) return
  logLoading.value = true
  const chunk = await window.scripty.history.readLog(selected.value.id, { offset: log.value?.nextOffset ?? 0, length: 64 * 1024 })
  logLoading.value = false
  if (chunk.ok === false) return emit('feedback', 'error', chunk.error.message)
  log.value = chunk.data
  const combined = logContent.value + chunk.data.content
  logContent.value = combined.length > 1024 * 1024 ? combined.slice(combined.length - 1024 * 1024) : combined
}

/** Closes the detail and releases any live buffer held open for a finished run. */
function closeDetail() {
  if (selected.value && detailMode.value === 'live' && !activeRunIds.value.has(selected.value.id)) {
    const nextLogs = { ...activeLogs.value }
    delete nextLogs[selected.value.id]
    activeLogs.value = nextLogs
  }
  detailVisible.value = false
  selected.value = null
  detailMode.value = null
  log.value = null
  logContent.value = ''
}

/** Starts a failed historical task through its current persisted configuration and refreshes the page afterward. */
async function retry(record: RunRecord) {
  if (retryingId.value) return
  retryingId.value = record.id
  const result = await window.scripty.history.retry(record.id)
  retryingId.value = null
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  emit('feedback', 'success', `已重跑“${record.taskNameSnapshot}”`)
  await loadHistory()
}

/** Opens a danger confirmation before deleting every persisted run record and its controlled log file. */
async function clearAllHistory() {
  if (cleaning.value) return
  const accepted = await props.requestConfirmation({
    title: '确认清空运行历史',
    message: '将清空所有运行历史记录及其日志，且无法恢复。确认继续？',
    type: 'danger',
    confirmText: '清空全部',
    cancelText: '取消'
  })
  if (!accepted) return

  cleaning.value = true
  const result = await window.scripty.history.clear()
  cleaning.value = false
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  emit('feedback', 'success', `已清空 ${result.data.recordsRemoved} 条记录和 ${result.data.logFilesRemoved} 个日志文件`)
  page.value = 1
  await loadHistory()
}

/** Moves to a valid history page and reloads its summaries. */
function movePage(nextPage: number) { page.value = Math.min(pageCount.value, Math.max(1, nextPage)); loadHistory() }

/** Formats an ISO timestamp as local `yyyy-mm-dd hh:mm:ss`, leaving unparseable values untouched. */
function formatDateTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Formats millisecond duration into a concise user-facing value. */
function formatDuration(durationMs: number | null) {
  if (durationMs === null) return '运行中'
  if (durationMs < 1000) return `${durationMs} ms`
  return `${(durationMs / 1000).toFixed(1)} s`
}

/** Adds a run id to the active set via reassignment so Vue re-renders dependent bindings. */
function markActive(runId: string) {
  if (activeRunIds.value.has(runId)) return
  activeRunIds.value = new Set(activeRunIds.value).add(runId)
}

/** Removes a run id from the active set via reassignment so Vue re-renders dependent bindings. */
function markInactive(runId: string) {
  if (!activeRunIds.value.has(runId)) return
  const next = new Set(activeRunIds.value)
  next.delete(runId)
  activeRunIds.value = next
}

/** Keeps the most recent live log entries within a byte budget, always retaining the latest entry. */
function capLogEntries(entries: ActiveLogEntry[], maxBytes: number): ActiveLogEntry[] {
  let total = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    total += entries[i].content.length
    if (total > maxBytes) return entries.slice(Math.min(i + 1, entries.length - 1))
  }
  return entries
}

/** Stops one active process tree and keeps the button locked until preload confirms a terminal record. */
async function stopActiveRun(runId: string) {
  const api = window.scripty?.runs
  if (!api || stoppingRunIds.value.has(runId)) return
  stoppingRunIds.value = new Set(stoppingRunIds.value).add(runId)
  await api.stop(runId)
  const next = new Set(stoppingRunIds.value)
  next.delete(runId)
  stoppingRunIds.value = next
}

/** Applies ordered run events: tracks active runs, streams live logs, and refreshes history on completion. */
function handleRunEvent(event: RunEvent) {
  const lastSequence = activeRunSequences.get(event.runId) ?? 0
  if (event.sequence <= lastSequence) return
  activeRunSequences.set(event.runId, event.sequence)
  if (event.type === 'finished') {
    markInactive(event.runId)
    // keep the live buffer if the open detail is still streaming this run, so the final output stays visible
    const viewingLive = selected.value?.id === event.runId && detailMode.value === 'live'
    if (!viewingLive) {
      const nextLogs = { ...activeLogs.value }
      delete nextLogs[event.runId]
      activeLogs.value = nextLogs
    }
    if (selected.value?.id === event.runId) selected.value = event.record
    void loadHistory()
  } else if (event.type === 'status' && event.record) {
    markActive(event.runId)
  } else if (event.type === 'stdout' || event.type === 'stderr') {
    const current = activeLogs.value[event.runId] ?? []
    const appended = [...current, { timestamp: new Date().toISOString(), type: event.type, content: event.chunk }]
    activeLogs.value = { ...activeLogs.value, [event.runId]: capLogEntries(appended, 1024 * 1024) }
  }
}

/** Loads active runs so cards and the detail drawer know which runs stream live logs. */
async function loadActiveRuns() {
  const api = window.scripty?.runs
  if (!api) return
  const result = await api.getActive()
  if (!mounted || result.ok === false) return
  const nextActive = new Set(activeRunIds.value)
  for (const snapshot of result.data) {
    const lastSequence = activeRunSequences.get(snapshot.id) ?? 0
    if (snapshot.sequence < lastSequence) continue
    nextActive.add(snapshot.id)
    activeRunSequences.set(snapshot.id, Math.max(lastSequence, snapshot.sequence))
  }
  activeRunIds.value = nextActive
}

/** Subscribes before any request so fast run events cannot be overwritten by a stale snapshot response. */
async function initializeHistory() {
  mounted = true
  unsubscribeRuns = window.scripty?.runs?.subscribe(handleRunEvent) ?? null
  void loadHistory()
  await loadActiveRuns()
}

/** Invalidates pending requests and releases the run-event subscription when the view leaves the DOM. */
function disposeHistory() {
  mounted = false
  historyRequestSequence += 1
  unsubscribeRuns?.()
  unsubscribeRuns = null
}

watch([search, status, trigger], () => { page.value = 1; void loadHistory() })
onMounted(initializeHistory)
onBeforeUnmount(disposeHistory)
</script>

<template>
  <section class="history-view" aria-labelledby="history-heading">
    <div class="view-toolbar">
      <div class="section-heading"><div><h2 id="history-heading">运行历史</h2></div><div class="section-heading__actions"><ZButton type="danger" size="small" :loading="cleaning" :disabled="total === 0" @click="clearAllHistory">全部清空</ZButton></div></div>
      <div class="history-filters">
        <ZInput v-model="search" placeholder="搜索任务、脚本" />
        <ZSelect v-model="status" :options="statusOptions" />
        <ZSelect v-model="trigger" :options="triggerOptions" />
      </div>
    </div>
    <p v-if="loading" class="task-message" role="status">正在加载运行历史…</p>
    <div v-else-if="records.length === 0" class="empty-state"><div class="empty-state__mark">H</div><h3>暂无运行记录</h3><p>任务完成或失败后会保留摘要。</p></div>
    <ul v-else class="history-list">
      <li v-for="record in records" :key="record.id" class="history-row">
        <div><strong>{{ record.taskNameSnapshot }}</strong><span>{{ record.scriptNameSnapshot }}</span></div>
        <RunStatusTag :status="record.status" />
        <dl><div><dt>触发</dt><dd>{{ triggerLabels[record.trigger] }}</dd></div><div><dt>耗时</dt><dd>{{ formatDuration(record.durationMs) }}</dd></div><div><dt>退出码</dt><dd>{{ record.exitCode ?? '—' }}</dd></div></dl>
        <p v-if="record.errorSummary" class="history-error">{{ record.errorSummary }}</p>
        <div class="history-row__actions">
          <ZButton size="small" @click="openDetail(record)">查看详情</ZButton>
          <ZButton v-if="activeRunIds.has(record.id)" type="danger" size="small" :loading="stoppingRunIds.has(record.id)" @click="stopActiveRun(record.id)">停止</ZButton>
          <ZButton v-if="record.status === 'failed'" size="small" type="primary" :loading="retryingId === record.id" @click="retry(record)">快速重跑</ZButton>
        </div>
      </li>
    </ul>
    <div class="history-pagination">
      <span class="history-pagination__total">共 {{ total }} 条</span>
      <div v-if="total > pageSize" class="history-pagination__controls">
        <ZButton size="small" :disabled="page <= 1" @click="movePage(page - 1)">上一页</ZButton>
        <span>{{ page }} / {{ pageCount }}</span>
        <ZButton size="small" :disabled="page >= pageCount" @click="movePage(page + 1)">下一页</ZButton>
      </div>
    </div>

    <ZDrawer v-model:show="detailVisible" placement="right" width="560" trap-focus auto-focus @update:show="(show: boolean) => { if (!show) closeDetail() }">
      <ZDrawerContent title="运行详情" closable>
        <div v-if="selected" class="history-detail">
          <div class="backup-preview__heading"><div><h3>{{ selected.taskNameSnapshot }}</h3><p>{{ selected.scriptNameSnapshot }}</p></div><RunStatusTag :status="selected.status" /></div>
          <dl class="backup-summary"><div><dt>开始</dt><dd>{{ formatDateTime(selected.startedAt) }}</dd></div><div><dt>结束</dt><dd>{{ formatDateTime(selected.finishedAt) }}</dd></div><div><dt>触发</dt><dd>{{ triggerLabels[selected.trigger] }}</dd></div><div><dt>耗时</dt><dd>{{ formatDuration(selected.durationMs) }}</dd></div><div><dt>退出码</dt><dd>{{ selected.exitCode ?? '—' }}</dd></div></dl>
          <p v-if="selected.errorSummary" class="history-error">{{ selected.errorSummary }}</p>
          <section>
            <div class="history-log__heading">
              <h4>运行日志</h4>
              <ZButton v-if="!isLiveDetail && log && !log.end" size="small" :loading="logLoading" @click="loadNextLogChunk">继续读取 64 KiB</ZButton>
            </div>
            <div v-if="visibleLogEntries.length" class="history-log history-log--grid">
              <template v-for="(entry, index) in visibleLogEntries" :key="index">
                <span class="history-log__meta" :class="`history-log__meta--${entry.type}`">[{{ entry.time }}] [{{ entry.type }}]</span>
                <span class="history-log__content">{{ entry.content }}</span>
              </template>
            </div>
            <pre v-else class="history-log">{{ isLiveDetail ? '等待输出…' : (logContent || '暂无日志') }}</pre>
            <p v-if="!isLiveDetail && logContent.length >= 1024 * 1024" class="task-message">页面仅保留最近 1 MiB 日志内容。</p>
          </section>
        </div>
      </ZDrawerContent>
    </ZDrawer>
  </section>
</template>

<style scoped lang="scss">
.history-view {
  padding-top: 0;
}

.history-filters {
  display: grid;
  grid-template-columns: auto repeat(2, 150px);
  gap: 12px;
  margin-bottom: 20px;
}

.history-row__actions,
.history-pagination,
.history-pagination__controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.history-row__actions {
  justify-content: flex-start;
}

/* zt-button--primary is a class on the ztools-ui button internals; reach it via :deep. */
.history-row__actions :deep(.zt-button--primary) {
  color: #fff !important;
}

.history-pagination {
  justify-content: space-between;
  margin-top: 18px;
}

.history-pagination__total {
  color: var(--text-secondary);
  font-size: 13px;
}

.history-detail {
  display: grid;
  gap: 20px;
  padding: 20px;
}

.history-detail h3,
.history-detail h4 {
  margin: 0;
}

.history-log__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.history-log {
  max-height: 420px;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--code-bg, var(--card-bg));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.6 "SFMono-Regular", Consolas, monospace;
}

.history-log--grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  row-gap: 2px;
  align-items: baseline;
  white-space: normal;
}

.history-log__meta {
  color: var(--text-secondary);
  white-space: nowrap;
  user-select: none;
}

.history-log__meta--stderr {
  color: var(--error-color);
}

.history-log__content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.history-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  height: 100%;
  overflow: auto;
  margin-bottom: 20px;
  /* top/bottom padding absorbs the focus glow on the row action buttons of the
     first/last row, which `overflow: auto` would otherwise clip. */
  padding-top: 8px;
  padding-bottom: 8px;
  padding-right: 10px;
}

.history-row {
  max-height: 150px;
  display: grid;
  grid-template-columns: minmax(160px, 1fr) auto minmax(120px, 1fr);
  align-items: center;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--card-bg);
}

.history-row > div:first-child {
  display: grid;
  gap: 4px;
}

.history-row > div:first-child span,
.history-row dt {
  color: var(--text-secondary);
  font-size: 12px;
}

.history-row dl {
  display: flex;
  justify-content: flex-end;
  gap: 20px;
  margin: 0;
}

.history-row dl div {
  display: grid;
  gap: 4px;
}

.history-row dd {
  margin: 0;
}

.history-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--error-color);
  font-size: 13px;
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
