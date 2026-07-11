<script lang="ts" setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { applyTheme, useToast, useZtoolsTheme } from 'ztools-ui'

const uiInput = ref('Scripty')
const { isDark, primaryColor } = useZtoolsTheme()
const {
  toastState,
  confirmState,
  success,
  confirm,
  handleConfirm,
  handleCancel
} = useToast()

onMounted(async () => {
  const originalTheme = {
    isDark: isDark.value,
    primaryColor: primaryColor.value,
    windowMaterial: document.documentElement.getAttribute('data-material') ?? ''
  }
  applyTheme({ ...originalTheme, isDark: true })
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const input = document.querySelector('.ui-probe input')
  window.services.lifecycleProbe.record('ztools-ui-dark-theme-verified', {
    rootHasDarkClass: document.documentElement.classList.contains('dark'),
    inputRendered: input instanceof HTMLInputElement,
    inputBackground: input ? getComputedStyle(input).backgroundColor : null
  })
  applyTheme(originalTheme)
})

defineProps({
  enterAction: {
    type: Object,
    required: true
  }
})

const probeStatus = window.services.lifecycleProbe.status()
const log = ref(window.services.lifecycleProbe.readLog())
const childLog = ref(window.services.childProcessProbe.readLog())
const childStatus = ref(window.services.childProcessProbe.status())
const entries = computed(() =>
  log.value
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleProbeEntry)
    .reverse()
)

function refreshLog() {
  log.value = window.services.lifecycleProbe.readLog()
}

function hideWindow() {
  window.services.lifecycleProbe.record('hide-window-requested')
  window.ztools.hideMainWindow()
}

function leavePlugin() {
  window.services.lifecycleProbe.record('plugin-background-requested')
  window.ztools.outPlugin(false)
}

function terminatePlugin() {
  window.services.lifecycleProbe.record('plugin-termination-requested')
  window.ztools.outPlugin(true)
}

function refreshChildLog() {
  childLog.value = window.services.childProcessProbe.readLog()
  childStatus.value = window.services.childProcessProbe.status()
}

function startChild() {
  window.services.childProcessProbe.start()
  refreshChildLog()
}

function stopChild() {
  window.services.childProcessProbe.stop()
  refreshChildLog()
}

async function verifyUiFeedback() {
  window.services.lifecycleProbe.record('ztools-ui-form-submitted', {
    value: uiInput.value,
    isDark: isDark.value,
    primaryColor: primaryColor.value
  })
  const accepted = await confirm({
    title: '验证 ztools-ui 弹窗',
    message: `确认提交表单值“${uiInput.value}”？`,
    type: 'info'
  })
  window.services.lifecycleProbe.record('ztools-ui-dialog-result', { accepted })
  if (accepted) {
    success('ztools-ui 通知验证成功')
    window.services.lifecycleProbe.record('ztools-ui-toast-shown', { type: 'success' })
  }
}

function clearLog() {
  window.services.lifecycleProbe.clearLog()
  refreshLog()
}
</script>

<template>
  <main class="lifecycle-probe">
    <ZToast v-bind="toastState" />
    <ZConfirmDialog
      v-bind="confirmState"
      @confirm="handleConfirm"
      @cancel="handleCancel"
      @update:visible="(visible) => { if (!visible) handleCancel() }"
    />
    <h1>Preload 生命周期探针</h1>
    <section class="ui-probe">
      <h2>ztools-ui 能力探针</h2>
      <p>主题：{{ isDark ? '暗色' : '亮色' }}，主色：{{ primaryColor ?? '默认' }}</p>
      <div class="actions">
        <ZInput v-model="uiInput" placeholder="输入表单值" clearable />
        <ZButton type="primary" @click="verifyUiFeedback">验证弹窗与通知</ZButton>
      </div>
    </section>
    <p>日志文件：<code>{{ probeStatus.lifecycleLogPath }}</code></p>
    <p>进程 PID：{{ probeStatus.pid }}，启动时间：{{ probeStatus.preloadStartedAt }}</p>
    <div class="actions">
      <button type="button" @click="hideWindow">隐藏主窗口</button>
      <button type="button" @click="leavePlugin">插件退到后台</button>
      <button type="button" @click="terminatePlugin">终止插件进程</button>
      <button type="button" @click="refreshLog">刷新日志</button>
      <button type="button" @click="clearLog">清空日志</button>
    </div>
    <section class="instructions">
      <h2>验证步骤</h2>
      <ol>
        <li>点击“隐藏主窗口”，等待至少 5 秒后重新输入 hello；若心跳连续且 PID 不变，窗口隐藏期间 preload 存活。</li>
        <li>点击“插件退到后台”，等待至少 5 秒后重新进入；检查 <code>plugin-out</code> 的 <code>processExit</code> 和心跳连续性。</li>
        <li>点击“终止插件进程”，等待至少 5 秒后重新进入；若心跳中断且 PID 改变，完全退出会终止 preload。</li>
        <li>完全退出 ZTools，等待至少 5 秒后重新启动并进入；比较日志末尾与新 PID，确认宿主退出后的行为。</li>
      </ol>
    </section>
    <section class="child-process-probe">
      <h2>Node 子进程探针</h2>
      <p>状态：{{ childStatus.running ? `运行中（PID ${childStatus.childPid}）` : '已停止' }}</p>
      <div class="actions">
        <button type="button" :disabled="childStatus.running" @click="startChild">启动固定测试进程</button>
        <button type="button" :disabled="!childStatus.running" @click="stopChild">停止测试进程</button>
        <button type="button" @click="refreshChildLog">刷新子进程日志</button>
      </div>
      <pre>{{ childLog }}</pre>
    </section>
    <ol class="events">
      <li v-for="(entry, index) in entries" :key="`${entry.timestamp}-${index}`">
        <time>{{ entry.timestamp }}</time>
        <strong>{{ entry.event }}</strong>
        <span>PID {{ entry.pid }}{{ entry.processExit === undefined ? '' : ` / processExit ${entry.processExit}` }}</span>
      </li>
    </ol>
  </main>
</template>

<style scoped>
.lifecycle-probe {
  padding: 24px 28px;
}

.lifecycle-probe code {
  user-select: all;
}

.actions {
  display: flex;
  gap: 8px;
  margin: 20px 0;
}

.actions button {
  padding: 0 14px;
}

.child-process-probe pre {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
}

.instructions {
  max-width: 900px;
  line-height: 1.6;
}

.instructions ol {
  padding-left: 24px;
}

.lifecycle-probe .events {
  padding-left: 24px;
}

.lifecycle-probe .events li {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(150px, 1fr) 100px;
  gap: 12px;
  padding: 6px 0;
}
</style>
