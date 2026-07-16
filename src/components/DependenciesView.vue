<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DependencyKind } from '../types/domain'
import type { DependencySummary, DependencyStatusSnapshot } from '../types/api'

const props = defineProps<{
  requestConfirmation: (options: { title: string; message: string; confirmText?: string; cancelText?: string }) => Promise<boolean>
}>()
const emit = defineEmits<{
  (event: 'feedback', type: 'success' | 'error', message: string): void
}>()

const activeKind = ref<DependencyKind>('node')
const dependencies = ref<DependencySummary[]>([])
const status = ref<DependencyStatusSnapshot | null>(null)
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const name = ref('')
const versionSpec = ref('latest')
const busy = ref<DependencyKind | 'save' | null>(null)
const output = ref('')
const currentDependencies = computed(() => dependencies.value.filter(item => item.kind === activeKind.value))
const kindLabels: Record<DependencyKind, string> = { node: 'Node.js', python: 'Python' }
const statusLabels = { installed: '已安装', missing: '缺失', stale: '待同步' } as const

/** Loads direct dependency declarations and per-ecosystem readiness in one view refresh. */
async function loadDependencies() {
  const [listResult, statusResult] = await Promise.all([
    window.scripty.dependencies.list(),
    window.scripty.dependencies.getStatus()
  ])
  if (listResult.ok === false) emit('feedback', 'error', listResult.error.message)
  else dependencies.value = listResult.data
  if (statusResult.ok === false) emit('feedback', 'error', statusResult.error.message)
  else status.value = statusResult.data
}

/** Opens a blank direct-dependency form for the currently selected ecosystem. */
function openCreateDialog() {
  editingId.value = null
  name.value = ''
  versionSpec.value = 'latest'
  dialogVisible.value = true
}

/** Opens version editing while keeping package identity immutable. */
function openVersionDialog(dependency: DependencySummary) {
  editingId.value = dependency.id
  name.value = dependency.name
  versionSpec.value = dependency.versionSpec
  dialogVisible.value = true
}

/** Adds a direct dependency or updates its declared version without installing implicitly. */
async function saveDependency() {
  if (busy.value || !name.value.trim() || !versionSpec.value.trim()) return
  busy.value = 'save'
  const result = editingId.value
    ? await window.scripty.dependencies.updateVersion(editingId.value, versionSpec.value)
    : await window.scripty.dependencies.add({ kind: activeKind.value, name: name.value, versionSpec: versionSpec.value })
  busy.value = null
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  dialogVisible.value = false
  await loadDependencies()
  emit('feedback', 'success', editingId.value ? '依赖版本已更新，请同步环境' : '依赖已添加，请同步环境')
}

/** Removes one direct declaration after confirmation and leaves the active environment intact until sync. */
async function removeDependency(dependency: DependencySummary) {
  const accepted = await props.requestConfirmation({
    title: '删除直接依赖',
    message: `确定删除“${dependency.name}”吗？环境会在下次同步时更新。`,
    confirmText: '删除',
    cancelText: '取消'
  })
  if (!accepted) return
  const result = await window.scripty.dependencies.remove(dependency.id)
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  await loadDependencies()
  emit('feedback', 'success', '依赖已删除，请同步环境')
}

/** Synchronizes the selected ecosystem through an isolated candidate environment and shows bounded output. */
async function syncDependencies() {
  if (busy.value) return
  const kind = activeKind.value
  busy.value = kind
  output.value = ''
  const result = await window.scripty.dependencies.sync(kind)
  busy.value = null
  if (result.ok === false) return emit('feedback', 'error', result.error.message)
  output.value = result.data.output || `${kindLabels[kind]} 依赖环境已同步。`
  await loadDependencies()
  emit('feedback', 'success', `${kindLabels[kind]} 依赖已同步`)
}

onMounted(loadDependencies)
</script>

<template>
  <section class="dependencies-view" aria-labelledby="dependencies-heading">
    <ZModal v-model:show="dialogVisible" :mask-closable="false" trap-focus auto-focus>
      <form class="dependency-form" @submit.prevent="saveDependency">
        <h3>{{ editingId ? '修改依赖版本' : `新增 ${kindLabels[activeKind]} 依赖` }}</h3>
        <label><span>包名</span><ZInput v-model="name" :disabled="Boolean(editingId)" placeholder="例如：lodash / requests" /></label>
        <label><span>版本</span><ZInput v-model="versionSpec" placeholder="例如：^4.17.21 / >=2.32" /></label>
        <p class="managed-copy-notice">仅支持 npm/PyPI 注册表包名和版本范围，不支持路径、URL、Git 或命令参数。</p>
        <div class="drawer-actions">
          <ZButton type="default" @click="dialogVisible = false">取消</ZButton>
          <ZButton type="primary" :loading="busy === 'save'" :disabled="!name.trim() || !versionSpec.trim()" @click="saveDependency">保存</ZButton>
        </div>
      </form>
    </ZModal>

    <div class="section-heading">
      <div>
        <h2 id="dependencies-heading">依赖管理</h2>
        <p>所有脚本共用 Scripty 数据目录中的隔离环境，不依赖全局第三方包。</p>
      </div>
      <div class="section-heading__actions">
        <ZButton type="default" @click="openCreateDialog">新增依赖</ZButton>
        <ZButton type="primary" :loading="busy === activeKind" :disabled="Boolean(busy)" @click="syncDependencies">同步环境</ZButton>
      </div>
    </div>

    <div class="view-toolbar dependency-kind-switch" role="group" aria-label="依赖类型">
      <ZButton :type="activeKind === 'node' ? 'primary' : 'default'" size="small" @click="activeKind = 'node'">Node.js</ZButton>
      <ZButton :type="activeKind === 'python' ? 'primary' : 'default'" size="small" @click="activeKind = 'python'">Python</ZButton>
      <ZTag v-if="status" :type="status[activeKind].ready ? 'success' : 'warning'" size="small">
        {{ status[activeKind].ready ? '环境已同步' : '环境待同步' }}
      </ZTag>
    </div>

    <div class="view-body">
      <div v-if="currentDependencies.length === 0" class="empty-state">
        <div class="empty-state__mark" aria-hidden="true">D</div>
        <h3>还没有 {{ kindLabels[activeKind] }} 直接依赖</h3>
        <p>新增依赖后点击“同步环境”，Scripty 会在应用本地环境中完成安装。</p>
      </div>
      <ul v-else class="dependency-list">
        <li v-for="dependency in currentDependencies" :key="dependency.id" class="dependency-row">
          <div>
            <strong>{{ dependency.name }}</strong>
            <p>声明 {{ dependency.versionSpec }} · 已安装 {{ dependency.installedVersion || '—' }}</p>
          </div>
          <div class="script-row__actions">
            <ZTag :type="dependency.status === 'installed' ? 'success' : dependency.status === 'missing' ? 'danger' : 'warning'" size="small">
              {{ statusLabels[dependency.status] }}
            </ZTag>
            <ZButton type="text" size="small" @click="openVersionDialog(dependency)">修改版本</ZButton>
            <ZButton type="text" size="small" @click="removeDependency(dependency)">删除</ZButton>
          </div>
        </li>
      </ul>
      <pre v-if="output" class="dependency-output">{{ output }}</pre>
    </div>
  </section>
</template>

<style scoped lang="scss">
.dependencies-view {
  padding-top: 0;
}

.dependency-kind-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 0;
}

.dependency-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dependency-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--card-bg);
}

.dependency-row p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.dependency-output {
  min-height: 0;
  max-height: 220px;
  margin: 16px 0 0;
  padding: 14px;
  border: 1px solid var(--input-border);
  border-radius: 10px;
  background: var(--input-bg);
  color: var(--text-color);
  font: 12px/1.6 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
