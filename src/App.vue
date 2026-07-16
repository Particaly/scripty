<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { applyTheme, useToast, useZtoolsTheme } from 'ztools-ui'
import TasksView from './components/TasksView.vue'
import ScriptsView from './components/ScriptsView.vue'
import SettingsView from './components/SettingsView.vue'
import RunsView from './components/RunsView.vue'
import HistoryView from './components/HistoryView.vue'
import EnvironmentsView from './components/EnvironmentsView.vue'
import BackupView from './components/BackupView.vue'
import DependenciesView from './components/DependenciesView.vue'
import {
  RUN_TASK_FEATURE,
  buildRunnableTaskCandidates,
  resolvePluginSection,
  resolveSelectedTask
} from './plugin-entry'
import type { SchedulerStatus } from './types/api'

const sections = [
  { id: 'tasks', label: '任务', title: '还没有任务', description: '创建任务后，可在这里管理运行方式、Cron 和启用状态。' },
  { id: 'scripts', label: '脚本', title: '还没有脚本', description: '新建或导入本地脚本后，源码副本将由 Scripty 托管。' },
  { id: 'dependencies', label: '依赖', title: '还没有依赖', description: '在这里管理所有脚本共享的 Node.js 与 Python 直接依赖。' },
  { id: 'environments', label: '环境变量', title: '还没有环境变量', description: '在这里维护任务运行时需要注入的全局变量和任务变量。' },
  { id: 'running', label: '运行中', title: '暂无运行记录', description: '任务执行后，可在这里查看实时输出。' },
  { id: 'history', label: '运行历史', title: '暂无运行记录', description: '任务执行后，可在这里查看状态、耗时、退出码和日志。' },
  { id: 'backups', label: '备份', title: '尚未生成备份预览', description: '选择需要迁移的数据后，可在这里检查导出内容。' },
  { id: 'settings', label: '设置', title: '设置尚未初始化', description: '后续可在这里配置解释器、任务超时和日志保留策略。' }
] as const

const activeSection = ref<(typeof sections)[number]['id']>('tasks')
const currentSection = computed(() =>
  sections.find((section) => section.id === activeSection.value) ?? sections[0]
)
const { toastState, confirmState, success, error, confirm, handleConfirm, handleCancel } = useToast()
const { isDark, primaryColor } = useZtoolsTheme()
const schedulerStatus = ref<SchedulerStatus>('unavailable')
const schedulerStatusView = computed(() => ({
  active: { label: '调度生效', type: 'success' as const, description: '已加载启用的 Cron 任务' },
  inactive: { label: '调度待命', type: 'info' as const, description: '调度器可用，暂无生效计划' },
  unavailable: { label: '调度不可用', type: 'danger' as const, description: '当前生命周期无法调度或状态无法读取' }
})[schedulerStatus.value])
let colorSchemeQuery: MediaQueryList | null = null
let confirmTrigger: HTMLElement | null = null
let unsubscribeSchedulerStatus: (() => void) | null = null
let schedulerPushReceived = false

/** Returns the rendered ztools-ui confirmation container so shared accessibility behavior can wrap it. */
function getConfirmDialog() {
  return document.querySelector<HTMLElement>('.dialog-container')
}

/** Adds generic dialog semantics and moves keyboard focus to the safe cancel action after opening. */
async function prepareConfirmDialog() {
  await nextTick()
  const dialog = getConfirmDialog()
  if (!dialog) return
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'scripty-dialog-title')
  dialog.querySelector<HTMLElement>('.dialog-title')?.setAttribute('id', 'scripty-dialog-title')
  dialog.querySelector<HTMLElement>('.btn-secondary')?.focus()
}

/** Keeps Tab focus inside the open confirmation dialog and lets Escape perform the cancel action. */
function handleDialogKeyboard(event: KeyboardEvent) {
  if (!confirmState.value.visible) return
  const dialog = getConfirmDialog()
  if (!dialog) return
  if (event.key === 'Escape') {
    event.preventDefault()
    handleCancel()
    return
  }
  if (event.key !== 'Tab') return

  const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'))
  if (controls.length === 0) return
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

/** Restores focus to the control that launched the confirmation flow after it closes. */
function restoreConfirmFocus() {
  const target = confirmTrigger
  confirmTrigger = null
  nextTick(() => target?.focus())
}

/** Subscribes before reading the scheduler snapshot so a late getter cannot overwrite a newer push. */
async function initializeSchedulerStatus() {
  const api = window.scripty?.app
  if (!api) {
    schedulerStatus.value = 'unavailable'
    return
  }
  unsubscribeSchedulerStatus = api.subscribeSchedulerStatus((status) => {
    schedulerPushReceived = true
    schedulerStatus.value = status
  })
  schedulerPushReceived = false
  const result = await api.getSchedulerStatus()
  if (result.ok === true && !schedulerPushReceived) schedulerStatus.value = result.data
  else if (result.ok === false) error(result.error.message)
}

/** Applies the host theme when available and otherwise follows the operating-system color scheme. */
function synchronizeTheme(event?: MediaQueryListEvent) {
  applyTheme({
    isDark: event?.matches ?? colorSchemeQuery?.matches ?? isDark.value,
    primaryColor: primaryColor.value,
    windowMaterial: document.documentElement.getAttribute('data-material') ?? ''
  })
}

/** Routes each plugin feature to its existing application section without interpreting host payloads as commands. */
function handlePluginEnter(action: { code: string }) {
  activeSection.value = resolvePluginSection(action.code)
}

/** Supplies display-only candidates for the run-task feature from the latest runnable task summaries. */
async function loadRunTaskCandidates(action: { code: string, payload: unknown }) {
  if (action.code !== RUN_TASK_FEATURE) return []
  const result = await window.scripty.tasks.list()
  if (result.ok === false) return []
  return buildRunnableTaskCandidates(result.data, action.payload)
}

/** Revalidates a selected host candidate against persisted tasks before starting it through the constrained run API. */
async function handleRunTaskSelection(action: { code: string, option: { title?: string, text: string } }) {
  if (action.code !== RUN_TASK_FEATURE) return
  const tasksResult = await window.scripty.tasks.list()
  if (tasksResult.ok === false) {
    activeSection.value = 'tasks'
    window.ztools.showMainWindow()
    error(tasksResult.error.message)
    return
  }
  const task = resolveSelectedTask(tasksResult.data, action.option)
  if (!task) {
    activeSection.value = 'tasks'
    window.ztools.showMainWindow()
    error('任务已不存在或当前不可运行，请重新选择')
    return
  }
  const runResult = await window.scripty.runs.start(task.id)
  if (runResult.ok === false) {
    activeSection.value = 'tasks'
    window.ztools.showMainWindow()
    error(runResult.error.message)
    return
  }
  activeSection.value = 'running'
  window.ztools.showMainWindow()
  success(`已启动任务“${task.name}”`)
}

onMounted(() => {
  colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  synchronizeTheme()
  initializeSchedulerStatus()
  window.ztools.onPluginEnter(handlePluginEnter)
  window.ztools.onMainPush(loadRunTaskCandidates, handleRunTaskSelection)
  colorSchemeQuery.addEventListener('change', synchronizeTheme)
  document.addEventListener('keydown', handleDialogKeyboard)
})

onBeforeUnmount(() => {
  unsubscribeSchedulerStatus?.()
  unsubscribeSchedulerStatus = null
  colorSchemeQuery?.removeEventListener('change', synchronizeTheme)
  document.removeEventListener('keydown', handleDialogKeyboard)
})

watch(
  () => confirmState.value.visible,
  (visible, wasVisible) => {
    if (visible) prepareConfirmDialog()
    else if (wasVisible) restoreConfirmFocus()
  }
)

/** Synchronizes the toast visible state when the component emits a close event. */
function handleToastVisibleChange(visible: boolean) {
  toastState.value.visible = visible
}

/** Routes child-view operation feedback through the single application-level ztools-ui toast. */
function showFeedback(type: 'success' | 'error', message: string) {
  if (type === 'success') success(message)
  else error(message)
}
</script>

<template>
  <div class="app-shell">
    <ZToast v-bind="toastState" @update:visible="handleToastVisibleChange" />
    <ZConfirmDialog
      v-bind="confirmState"
      @confirm="handleConfirm"
      @cancel="handleCancel"
      @update:visible="(visible) => { if (!visible) handleCancel() }"
    />

    <aside class="app-sidebar">
      <div class="app-sidebar__brand">
        <span class="app-sidebar__mark" aria-hidden="true">S</span>
        <div class="app-sidebar__title">
          <h1>Scripty</h1>
          <p>本地脚本管理</p>
        </div>
      </div>

      <nav class="app-nav" aria-label="主导航">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          :class="['app-nav__item', { 'app-nav__item--active': activeSection === section.id }]"
          :aria-current="activeSection === section.id ? 'page' : undefined"
          @click="activeSection = section.id"
        >
          {{ section.label }}
        </button>
      </nav>

      <div class="app-sidebar__footer">
        <div
          class="scheduler-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span
            :class="['scheduler-status__dot', `scheduler-status__dot--${schedulerStatusView.type}`]"
            aria-hidden="true"
          ></span>
          <span class="scheduler-status__label">调度器</span>
          <ZPopover placement="top" :show-arrow="true" class="scheduler-status__popover">
            <template #trigger>
              <button
                type="button"
                class="scheduler-status__hint"
                :aria-label="`调度状态：${schedulerStatusView.label}`"
              >?</button>
            </template>
            <div class="scheduler-hint">
              <p class="scheduler-hint__title">{{ schedulerStatusView.label }}</p>
              <p class="scheduler-hint__desc">{{ schedulerStatusView.description }}</p>
              <p class="scheduler-hint__note">定时任务仅在 Scripty 插件存活期间调度，插件进程终止或 ZTools 退出后调度将停止。数据保存在当前设备。</p>
            </div>
          </ZPopover>
        </div>
      </div>
    </aside>

    <main class="app-main">

      <TasksView
        v-if="activeSection === 'tasks'"
        :request-confirmation="confirm"
        @feedback="showFeedback"
      />

      <ScriptsView v-else-if="activeSection === 'scripts'" :request-confirmation="confirm" @feedback="showFeedback" />

      <DependenciesView v-else-if="activeSection === 'dependencies'" :request-confirmation="confirm" @feedback="showFeedback" />

      <EnvironmentsView v-else-if="activeSection === 'environments'" :request-confirmation="confirm" @feedback="showFeedback" />

      <RunsView v-else-if="activeSection === 'running'" />

      <HistoryView v-else-if="activeSection === 'history'" @feedback="showFeedback" />

      <BackupView
        v-else-if="activeSection === 'backups'"
        :request-confirmation="confirm"
        @feedback="showFeedback"
      />

      <SettingsView v-else-if="activeSection === 'settings'" @feedback="showFeedback" />

      <section v-else class="empty-state" aria-live="polite">
        <div class="empty-state__mark" aria-hidden="true">S</div>
        <h2>{{ currentSection.title }}</h2>
        <p>{{ currentSection.description }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped lang="scss">
.app-shell {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  min-width: 800px;
  height: 100vh;
}

.app-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 20px 14px;
  border-right: 1px solid var(--divider-color);
  background: var(--card-bg);
}

.app-sidebar__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px 16px;
  border-bottom: 1px solid var(--divider-color);
}

.app-sidebar__mark {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 11px;
  background: var(--primary-light-bg);
  color: var(--primary-color);
  font-size: 18px;
  font-weight: 700;
}

.app-sidebar__title h1 {
  margin: 0;
  font-size: 17px;
  line-height: 1.2;
}

.app-sidebar__title p {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.app-nav {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  /* horizontal padding reserves room for the focus ring on nav buttons,
     otherwise `overflow-y: auto` clips the ring on the left/right edges. */
  padding: 14px 8px;
  overflow-y: auto;
}

.app-nav__item {
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-color);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.app-nav__item:hover {
  background: var(--hover-bg);
}

.app-nav__item--active {
  background: var(--primary-light-bg);
  color: var(--primary-color);
  font-weight: 600;
}

.app-sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--divider-color);
}

.scheduler-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.scheduler-status__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--text-secondary);
}

.scheduler-status__dot--success {
  background: var(--success-color, #22c55e);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success-color, #22c55e) 22%, transparent);
}

.scheduler-status__dot--info {
  background: var(--info-color, #3b82f6);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--info-color, #3b82f6) 22%, transparent);
}

.scheduler-status__dot--danger {
  background: var(--danger-color, #ef4444);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger-color, #ef4444) 22%, transparent);
}

.scheduler-status__label {
  flex: 1;
}

.scheduler-status__hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--control-border);
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1;
  cursor: help;
}

.scheduler-status__hint:hover {
  color: var(--text-color);
  border-color: var(--text-secondary);
}

.scheduler-hint {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scheduler-hint__title {
  margin: 0;
  color: var(--text-color);
  font-size: 13px;
  font-weight: 600;
}

.scheduler-hint__desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.scheduler-hint__note {
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.app-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  padding: 0 36px;
  overflow: hidden;
}

/* Scoped styles reach child component root elements (each view's root) via Vue's
   default behavior of stamping the scope id on child roots, so this stays effective. */
.app-main > * {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  /* Reserves room for the focus ring/glow painted outside ztools-ui control
     borders. `overflow: hidden` would otherwise clip it on toolbar controls
     sitting near the view root's top/left/right edges. */
  padding: 8px;
  overflow: hidden;
}

@media (max-width: 760px) {
  .app-shell {
    grid-template-columns: 176px minmax(0, 1fr);
  }

  .app-sidebar {
    padding: 16px 10px;
  }

  .app-main {
    padding-right: 24px;
    padding-left: 24px;
  }
}
</style>
