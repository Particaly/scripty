<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LogChunk, RunEvent, TaskSummary } from '../types/api'
import type { RunRecord, RunStatus, RunTrigger } from '../types/domain'
import RunStatusTag from './RunStatusTag.vue'

const emit = defineEmits<{ (event: 'feedback', type: 'success' | 'error', message: string): void }>()
const records = ref<RunRecord[]>([])
const tasks = ref<TaskSummary[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const search = ref('')
const status = ref<RunStatus | ''>('')
const trigger = ref<RunTrigger | ''>('')
const taskId = ref('')
const loading = ref(false)
const detailVisible = ref(false)
const selected = ref<RunRecord | null>(null)
const log = ref<LogChunk | null>(null)
const logContent = ref('')
const logLoading = ref(false)
const retryingId = ref<string | null>(null)
const cleaning = ref(false)
const triggerLabels = { manual: '手动', cron: '定时', retry: '重跑' } as const
const statusOptions = [
  { label: '全部状态', value: '' }, { label: '成功', value: 'success' }, { label: '失败', value: 'failed' },
  { label: '超时', value: 'timed_out' }, { label: '已停止', value: 'stopped' }, { label: '异常中断', value: 'interrupted' }
]
const triggerOptions = [{ label: '全部来源', value: '' }, { label: '手动', value: 'manual' }, { label: '定时', value: 'cron' }, { label: '重跑', value: 'retry' }]
const taskOptions = computed(() => [{ label: '全部任务', value: '' }, ...tasks.value.map(task => ({ label: task.name, value: task.id }))])
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
let historyRequestSequence = 0
let unsubscribeRuns: (() => void) | null = null
let mounted = false

/** Loads one filtered page and allows only the newest request to replace the visible history snapshot. */
async function loadHistory() {
  const requestSequence = ++historyRequestSequence
  loading.value = true
  const result = await window.scripty?.history?.list({ page: page.value, pageSize, search: search.value || undefined, status: status.value || undefined, trigger: trigger.value || undefined, taskId: taskId.value || undefined })
  if (!mounted || requestSequence !== historyRequestSequence) return
  loading.value = false
  if (result?.ok === true) {
    records.value = result.data.items
    total.value = result.data.total
  } else if (result?.ok === false) emit('feedback', 'error', result.error.message)
}

/** Loads task names for the history task filter without exposing task configuration. */
async function loadTasks() {
  const result = await window.scripty?.tasks?.list()
  if (result?.ok === true) tasks.value = result.data
}

/** Opens one authoritative history detail and reads only its first bounded log chunk. */
async function openDetail(record: RunRecord) {
  const detail = await window.scripty.history.get(record.id)
  if (detail.ok === false) return emit('feedback', 'error', detail.error.message)
  selected.value = detail.data
  detailVisible.value = true
  logContent.value = ''
  await loadNextLogChunk()
}

/** Appends one bounded 64 KiB history log chunk while capping renderer memory at 1 MiB. */
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

/** Closes the history detail and releases its bounded renderer log buffer. */
function closeDetail() { detailVisible.value = false; selected.value = null; log.value = null; logContent.value = '' }

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

/** Applies configured retention limits and reports the authoritative cleanup summary. */
async function cleanBySettings() {
  if (cleaning.value) return
  cleaning.value = true
  const settings = await window.scripty.settings.get()
  if (settings.ok === false) { cleaning.value = false; return emit('feedback', 'error', settings.error.message) }
  const retention = settings.data.logRetention
  const olderThan = retention.maxAgeDays === null ? undefined : new Date(Date.now() - retention.maxAgeDays * 86400000).toISOString()
  const result = await window.scripty.history.clear({ maxRunsPerTask: retention.maxRunsPerTask ?? undefined, olderThan })
  cleaning.value = false
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  emit('feedback', 'success', `已清理 ${result.data.recordsRemoved} 条记录和 ${result.data.logFilesRemoved} 个日志文件`)
  page.value = 1
  await loadHistory()
}

/** Moves to a valid history page and reloads its summaries. */
function movePage(nextPage: number) { page.value = Math.min(pageCount.value, Math.max(1, nextPage)); loadHistory() }

/** Formats millisecond duration into a concise user-facing value. */
function formatDuration(durationMs: number | null) {
  if (durationMs === null) return '运行中'
  if (durationMs < 1000) return `${durationMs} ms`
  return `${(durationMs / 1000).toFixed(1)} s`
}

/** Refreshes the filtered page and any open detail when an active run reaches a terminal state. */
function handleRunEvent(event: RunEvent) {
  if (event.type !== 'finished') return
  if (selected.value?.id === event.runId) selected.value = event.record
  void loadHistory()
}

/** Subscribes before the first history request so a fast completion cannot be overwritten by a stale response. */
function initializeHistory() {
  mounted = true
  unsubscribeRuns = window.scripty?.runs?.subscribe(handleRunEvent) ?? null
  void loadTasks()
  void loadHistory()
}

/** Invalidates pending requests and releases the run-event subscription when the view leaves the DOM. */
function disposeHistory() {
  mounted = false
  historyRequestSequence += 1
  unsubscribeRuns?.()
  unsubscribeRuns = null
}

watch([search, status, trigger, taskId], () => { page.value = 1; void loadHistory() })
onMounted(initializeHistory)
onBeforeUnmount(disposeHistory)
</script>

<template>
  <section class="history-view" aria-labelledby="history-heading">
    <div class="section-heading"><div><h2 id="history-heading">运行历史</h2><p>筛选运行结果、查看详情和首段日志，并快速重跑失败任务。</p></div><div class="section-heading__actions"><ZTag type="info">{{ total }} 条</ZTag><ZButton size="small" :loading="cleaning" @click="cleanBySettings">按保留策略清理</ZButton></div></div>
    <div class="history-filters">
      <ZInput v-model="search" placeholder="搜索任务、脚本或错误" />
      <ZSelect v-model="status" :options="statusOptions" />
      <ZSelect v-model="trigger" :options="triggerOptions" />
      <ZSelect v-model="taskId" :options="taskOptions" />
    </div>
    <p v-if="loading" class="task-message" role="status">正在加载运行历史…</p>
    <div v-else-if="records.length === 0" class="empty-state"><div class="empty-state__mark">H</div><h3>暂无运行记录</h3><p>任务完成或失败后会保留摘要。</p></div>
    <ul v-else class="history-list">
      <li v-for="record in records" :key="record.id" class="history-row">
        <div><strong>{{ record.taskNameSnapshot }}</strong><span>{{ record.scriptNameSnapshot }}</span></div>
        <RunStatusTag :status="record.status" />
        <dl><div><dt>触发</dt><dd>{{ triggerLabels[record.trigger] }}</dd></div><div><dt>耗时</dt><dd>{{ formatDuration(record.durationMs) }}</dd></div><div><dt>退出码</dt><dd>{{ record.exitCode ?? '—' }}</dd></div></dl>
        <p v-if="record.errorSummary" class="history-error">{{ record.errorSummary }}</p>
        <div class="history-row__actions"><ZButton size="small" @click="openDetail(record)">查看详情</ZButton><ZButton v-if="record.status === 'failed'" size="small" type="primary" :loading="retryingId === record.id" @click="retry(record)">快速重跑</ZButton></div>
      </li>
    </ul>
    <div v-if="total > pageSize" class="history-pagination"><ZButton size="small" :disabled="page <= 1" @click="movePage(page - 1)">上一页</ZButton><span>{{ page }} / {{ pageCount }}</span><ZButton size="small" :disabled="page >= pageCount" @click="movePage(page + 1)">下一页</ZButton></div>

    <ZDrawer v-model:show="detailVisible" placement="right" width="560" trap-focus auto-focus @update:show="(show: boolean) => { if (!show) closeDetail() }">
      <ZDrawerContent title="运行详情" closable>
      <div v-if="selected" class="history-detail">
        <div class="backup-preview__heading"><div><h3>{{ selected.taskNameSnapshot }}</h3><p>{{ selected.scriptNameSnapshot }}</p></div><RunStatusTag :status="selected.status" /></div>
        <dl class="backup-summary"><div><dt>开始</dt><dd>{{ selected.startedAt }}</dd></div><div><dt>结束</dt><dd>{{ selected.finishedAt ?? '—' }}</dd></div><div><dt>触发</dt><dd>{{ triggerLabels[selected.trigger] }}</dd></div><div><dt>耗时</dt><dd>{{ formatDuration(selected.durationMs) }}</dd></div><div><dt>退出码</dt><dd>{{ selected.exitCode ?? '—' }}</dd></div></dl>
        <p v-if="selected.errorSummary" class="history-error">{{ selected.errorSummary }}</p>
        <section><div class="history-log__heading"><h4>运行日志</h4><ZButton v-if="log && !log.end" size="small" :loading="logLoading" @click="loadNextLogChunk">继续读取 64 KiB</ZButton></div><pre class="history-log">{{ logContent || '暂无日志' }}</pre><p v-if="logContent.length >= 1024 * 1024" class="task-message">页面仅保留最近 1 MiB 日志内容。</p></section>
      </div>
      </ZDrawerContent>
    </ZDrawer>
  </section>
</template>
