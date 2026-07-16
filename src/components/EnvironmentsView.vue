<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { EnvironmentInput, EnvironmentSummary, TaskSummary } from '../types/api'

const emit = defineEmits<{ (event: 'feedback', type: 'success' | 'error', message: string): void }>()
const props = defineProps<{ requestConfirmation: (options: { title: string; message: string; type: 'danger' | 'warning'; confirmText: string; cancelText: string }) => Promise<boolean> }>()
const variables = ref<EnvironmentSummary[]>([])
const tasks = ref<TaskSummary[]>([])
const drawerVisible = ref(false)
const editingId = ref<string | null>(null)
const form = ref<EnvironmentInput>(emptyInput())
const revealedValues = ref<Record<string, string>>({})
const importPreview = ref<{ previewToken: string; entries: Array<{ name: string; value: string }>; conflicts: string[] } | null>(null)
const scopeOptions = [{ label: '全局', value: 'global' }, { label: '任务', value: 'task' }]

/** Creates a fresh global environment-variable draft. */
function emptyInput(): EnvironmentInput { return { name: '', value: '', note: '', scope: 'global', taskId: null, enabled: true, sensitive: false } }

/** Loads variable summaries and task choices without requesting sensitive plaintext. */
async function loadData() {
  const [variablesResult, tasksResult] = await Promise.all([window.scripty?.environments?.list(), window.scripty?.tasks?.list()])
  if (variablesResult?.ok === true) variables.value = variablesResult.data
  if (tasksResult?.ok === true) tasks.value = tasksResult.data
}

/** Opens an empty creation drawer. */
function createVariable() { editingId.value = null; form.value = emptyInput(); drawerVisible.value = true }

/** Opens an edit drawer; sensitive values remain blank unless explicitly replaced. */
function editVariable(variable: EnvironmentSummary) {
  editingId.value = variable.id
  form.value = { name: variable.name, value: variable.sensitive ? '' : variable.maskedValue, note: variable.note, scope: variable.scope, taskId: variable.taskId, enabled: variable.enabled, sensitive: variable.sensitive }
  drawerVisible.value = true
}

/** Persists a new or edited environment variable and refreshes masked summaries. */
async function saveVariable() {
  const api = window.scripty?.environments
  if (!api) return
  if (form.value.scope === 'global') form.value.taskId = null
  const result = editingId.value ? await api.update(editingId.value, form.value) : await api.create(form.value)
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  drawerVisible.value = false; await loadData(); emit('feedback', 'success', editingId.value ? '环境变量已更新' : '环境变量已创建')
}

/** Selects a dotenv file and imports its preview into the global scope after confirmation. */
async function importDotEnv() {
  const api = window.scripty?.environments
  if (!api) return
  const preview = await api.chooseDotEnvImport()
  if (preview.ok === false) return emit('feedback', 'error', preview.error.message)
  if (!preview.data) return
  importPreview.value = preview.data
  if (!await props.requestConfirmation({ title: '导入 .env', message: `导入 ${preview.data.entries.length} 个变量？${preview.data.conflicts.length ? ` ${preview.data.conflicts.length} 个同名变量将覆盖。` : ''}`, type: 'warning', confirmText: '导入', cancelText: '取消' })) return
  const result = await api.importDotEnv(preview.data.previewToken, { scope: 'global', taskId: null, sensitive: false, overwriteExisting: true })
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  await loadData(); emit('feedback', 'success', `已导入 ${result.data.created + result.data.updated} 个变量`)
}

/** Exports dotenv values and requires a second warning when any selected value is sensitive. */
async function exportDotEnv() {
  const api = window.scripty?.environments
  if (!api) return
  const containsSensitive = variables.value.some(variable => variable.sensitive)
  if (containsSensitive && !await props.requestConfirmation({ title: '导出敏感值', message: '导出文件将包含本地明文敏感值，是否继续？', type: 'warning', confirmText: '继续导出', cancelText: '取消' })) return
  const result = await api.exportDotEnv({ includeSensitiveValues: containsSensitive })
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  if (result.data) emit('feedback', 'success', `已导出 ${result.data.displayName}`)
}

/** Reveals one sensitive value only after explicit warning confirmation. */
async function revealVariable(variable: EnvironmentSummary) {
  if (!await props.requestConfirmation({ title: '查看敏感值', message: `显示 ${variable.name} 的本地明文值？`, type: 'warning', confirmText: '显示', cancelText: '取消' })) return
  const result = await window.scripty?.environments?.reveal(variable.id)
  if (result?.ok === false) return emit('feedback', 'error', result.error.message)
  if (result?.ok === true) revealedValues.value = { ...revealedValues.value, [variable.id]: result.data.value }
}

/** Copies one value only after explicit confirmation and reveal through preload. */
async function copyVariable(variable: EnvironmentSummary) {
  if (!await props.requestConfirmation({ title: '复制环境变量', message: `复制 ${variable.name} 的值到剪贴板？`, type: 'warning', confirmText: '复制', cancelText: '取消' })) return
  const result = await window.scripty?.environments?.reveal(variable.id)
  if (result?.ok === false) return emit('feedback', 'error', result.error.message)
  if (result?.ok === true) {
    await navigator.clipboard.writeText(result.data.value)
    emit('feedback', 'success', `${variable.name} 已复制`)
  }
}

/** Toggles one variable directly from the list while keeping its value inside preload. */
async function setEnabled(variable: EnvironmentSummary, enabled: boolean) {
  const result = await window.scripty?.environments?.setEnabled(variable.id, enabled)
  if (result?.ok === false) return emit('feedback', 'error', result.error.message)
  await loadData()
  emit('feedback', 'success', enabled ? `${variable.name} 已启用` : `${variable.name} 已禁用`)
}

/** Confirms and removes one environment variable. */
async function removeVariable(variable: EnvironmentSummary) {
  if (!await props.requestConfirmation({ title: '删除环境变量', message: `确定删除 ${variable.name}？`, type: 'danger', confirmText: '删除', cancelText: '取消' })) return
  const result = await window.scripty?.environments?.remove(variable.id)
  if (result?.ok === false) return emit('feedback', 'error', result.error.message)
  await loadData(); emit('feedback', 'success', `已删除 ${variable.name}`)
}

onMounted(loadData)
</script>

<template>
  <section class="environments-view">
    <ZDrawer v-model:show="drawerVisible" placement="right" width="420" trap-focus>
      <ZDrawerContent :title="editingId ? '编辑环境变量' : '创建环境变量'" closable>
        <form class="task-form" @submit.prevent="saveVariable">
          <label><span>名称</span><ZInput v-model="form.name" placeholder="API_TOKEN" /></label>
          <label><span>值</span><ZInput v-model="form.value" :type="form.sensitive ? 'password' : 'text'" placeholder="变量值" /></label>
          <label><span>作用域</span><ZSelect v-model="form.scope" :options="scopeOptions" /></label>
          <label v-if="form.scope === 'task'"><span>任务</span><ZSelect v-model="form.taskId" :options="tasks.map(task => ({ label: task.name, value: task.id }))" /></label>
          <label><span>备注</span><ZInput v-model="form.note" /></label>
          <div class="task-form__switch"><span>启用</span><ZSwitch v-model="form.enabled" /></div>
          <div class="task-form__switch"><span>敏感值</span><ZSwitch v-model="form.sensitive" /></div>
        </form>
        <template #footer><div class="drawer-actions"><ZButton @click="drawerVisible=false">取消</ZButton><ZButton type="primary" @click="saveVariable">保存</ZButton></div></template>
      </ZDrawerContent>
    </ZDrawer>
    <div class="section-heading"><div><h2>环境变量</h2></div><div class="section-heading__actions"><ZButton @click="importDotEnv">导入 .env</ZButton><ZButton :disabled="variables.length===0" @click="exportDotEnv">导出 .env</ZButton><ZButton type="primary" @click="createVariable">创建变量</ZButton></div></div>
    <div v-if="variables.length === 0" class="empty-state"><div class="empty-state__mark">E</div><h3>还没有环境变量</h3></div>
    <ul v-else class="environment-list"><li v-for="variable in variables" :key="variable.id" class="environment-row"><div><strong>{{ variable.name }}</strong><p>{{ revealedValues[variable.id] ?? variable.maskedValue }}</p><span>{{ variable.note || '暂无备注' }}</span></div><div class="environment-tags"><ZTag>{{ variable.scope === 'global' ? '全局' : '任务' }}</ZTag><ZTag v-if="variable.sensitive" type="warning">敏感</ZTag></div><div class="task-row__actions"><ZSwitch :model-value="variable.enabled" :aria-label="`${variable.enabled ? '禁用' : '启用'}变量 ${variable.name}`" @update:model-value="(enabled) => setEnabled(variable, enabled)" /><ZButton v-if="variable.sensitive" type="text" @click="revealVariable(variable)">查看</ZButton><ZButton type="text" @click="copyVariable(variable)">复制</ZButton><ZButton type="text" @click="editVariable(variable)">编辑</ZButton><ZButton type="danger" @click="removeVariable(variable)">删除</ZButton></div></li></ul>
  </section>
</template>

<style scoped lang="scss">
.environments-view {
  padding-top: 0;
}

.security-notice {
  max-width: 680px;
  margin-top: 10px !important;
  padding: 9px 12px;
  border-left: 3px solid var(--warning-color);
  background: var(--warning-light-bg);
  line-height: 1.6;
}

.environment-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.environment-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--card-bg);
}

.environment-row span {
  color: var(--text-secondary);
  font-size: 12px;
}

.environment-tags {
  display: flex;
  gap: 6px;
}

.environment-row p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-family: "SFMono-Regular", Consolas, monospace;
}
</style>
