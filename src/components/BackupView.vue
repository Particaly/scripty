<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { BackupImportMode, BackupImportSummary, ExportPreview, ImportChangePreview, ImportPackagePreview, SaveSummary, SensitiveExportConfirmation } from '../types/api'
import type { ExportOptions } from '../types/domain'

const emit = defineEmits<{
  (event: 'feedback', type: 'success' | 'error', message: string): void
}>()
const props = defineProps<{
  requestConfirmation: (options: {
    title: string
    message: string
    type: 'danger' | 'warning'
    confirmText: string
    cancelText: string
  }) => Promise<boolean>
}>()

const options = ref<ExportOptions>({
  includeEnvironments: false,
  includeEnvironmentValues: false,
  includeSensitiveValues: false
})
const preview = ref<ExportPreview | null>(null)
const previewConfirmation = ref<SensitiveExportConfirmation | undefined>()
const exportResult = ref<SaveSummary | null>(null)
const operation = ref<'preview' | 'export' | 'import-validation' | 'import' | null>(null)
const expired = ref(false)
const importPreview = ref<ImportPackagePreview | null>(null)
const importMode = ref<BackupImportMode>('merge')
const importResult = ref<BackupImportSummary | null>(null)
const importValidationTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const previewAvailable = computed(() => typeof window.scripty?.backups?.previewExport === 'function')
let requestGeneration = 0
let expiryTimer: ReturnType<typeof setTimeout> | null = null

/** Formats a saved archive size for the persistent result without exposing its absolute path. */
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Formats one import mode's total counters into concise preview text. */
function formatImportChanges(mode: ImportChangePreview) {
  const counts = mode.total
  return `新增 ${counts.added} · 更新 ${counts.updated} · 保留 ${counts.retained} · 重名 ${counts.conflicts} · 将删除 ${counts.deleted}`
}

/** Clears the renderer copy of an import preview without consuming or exposing its preload snapshot. */
function invalidateImportPreview() {
  importPreview.value = null
  if (importValidationTimer.value !== null) clearTimeout(importValidationTimer.value)
  importValidationTimer.value = null
}

/** Clears preview credentials and invalidates in-flight responses tied to older options or consumed tokens. */
function invalidatePreview(markExpired = false) {
  requestGeneration += 1
  preview.value = null
  previewConfirmation.value = undefined
  expired.value = markExpired
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimer = null
}

/** Applies parent-child option constraints before the options watcher invalidates previous state. */
function updateEnvironmentInclusion(included: boolean) {
  options.value.includeEnvironments = included
  if (!included) {
    options.value.includeEnvironmentValues = false
    options.value.includeSensitiveValues = false
  }
}

/** Clears sensitive inclusion whenever ordinary environment values are disabled. */
function updateValueInclusion(included: boolean) {
  options.value.includeEnvironmentValues = included
  if (!included) options.value.includeSensitiveValues = false
}

/** Requests the one explicit plaintext-risk acknowledgement needed to build and later save a sensitive snapshot. */
async function confirmSensitiveExport() {
  const accepted = await props.requestConfirmation({
    title: '导出敏感值',
    message: '预览将读取并在 preload 内短暂缓存本地明文敏感值，最终 ZIP 中也会包含这些值。任何能够访问该文件的人都可能读取它们，是否继续？',
    type: 'warning',
    confirmText: '确认并生成预览',
    cancelText: '取消'
  })
  return accepted ? { acknowledgedPlaintextRisk: true } as const : undefined
}

/** Builds an immutable repository-backed preview after obtaining any required sensitive-value acknowledgement. */
async function generatePreview() {
  const api = window.scripty?.backups?.previewExport
  if (!api || operation.value) return
  const input = { ...options.value }
  const confirmation = input.includeSensitiveValues ? await confirmSensitiveExport() : undefined
  if (input.includeSensitiveValues && !confirmation) return
  invalidatePreview()
  exportResult.value = null
  const generation = requestGeneration
  operation.value = 'preview'
  const result = await api(input, confirmation)
  operation.value = null
  if (generation !== requestGeneration) return
  if (result.ok === false) {
    emit('feedback', 'error', result.error.message)
    return
  }
  preview.value = result.data
  previewConfirmation.value = confirmation
  const expiryDelay = Math.max(0, Date.parse(result.data.expiresAt) - Date.now())
  expiryTimer = setTimeout(() => invalidatePreview(true), expiryDelay)
}

/** Consumes the current preview once and renders an authoritative save result from preload. */
async function exportBackup() {
  const api = window.scripty?.backups?.export
  const currentPreview = preview.value
  if (!api || !currentPreview || operation.value) return
  operation.value = 'export'
  const result = await api(currentPreview.previewToken, previewConfirmation.value)
  operation.value = null
  invalidatePreview()
  if (result.ok === false) {
    emit('feedback', 'error', result.error.message)
    return
  }
  if (!result.data) return
  exportResult.value = result.data
  const warning = result.data.containsSensitiveValues ? '；包内包含本地明文敏感信息，请妥善保管' : ''
  emit('feedback', 'success', `已导出 ${result.data.displayName}${warning}`)
}

/** Selects and validates a ZIP while retaining only presentation state until the preload token expires. */
async function validateImportBackup() {
  const api = window.scripty?.backups?.chooseImportPackage
  if (!api || operation.value) return
  invalidateImportPreview()
  operation.value = 'import-validation'
  const result = await api()
  operation.value = null
  if (result.ok === false) {
    emit('feedback', 'error', result.error.message)
    return
  }
  if (!result.data) return
  importPreview.value = result.data
  const delay = Math.max(0, Date.parse(result.data.expiresAt) - Date.now())
  importValidationTimer.value = setTimeout(invalidateImportPreview, delay)
  emit('feedback', 'success', '备份包校验通过，已生成变更预览')
}

/** Applies the selected import mode once through the preload-held validation snapshot. */
async function applyImportBackup() {
  const api = window.scripty?.backups?.import
  const currentPreview = importPreview.value
  if (!api || !currentPreview || operation.value) return
  let confirmation: { acknowledgedOverwriteRisk: true } | undefined
  if (importMode.value === 'overwrite') {
    const accepted = await props.requestConfirmation({
      title: '确认覆盖恢复',
      message: '将先在本机备份目录创建包含当前脚本、任务、设置和环境变量值的完整备份，然后按导入包替换现有实体。确认继续？',
      type: 'danger',
      confirmText: '创建备份并覆盖',
      cancelText: '取消'
    })
    if (!accepted) return
    confirmation = { acknowledgedOverwriteRisk: true }
  }
  operation.value = 'import'
  const result = await api(currentPreview.validationToken, { mode: importMode.value }, confirmation)
  operation.value = null
  invalidateImportPreview()
  if (result.ok === false) {
    emit('feedback', 'error', result.error.message)
    return
  }
  importResult.value = result.data
  emit('feedback', 'success', importMode.value === 'merge' ? '合并导入完成' : '覆盖恢复完成')
}

watch(options, () => {
  invalidatePreview()
  exportResult.value = null
}, { deep: true })
onBeforeUnmount(() => {
  invalidatePreview()
  invalidateImportPreview()
})
</script>

<template>
  <section class="backup-view" aria-labelledby="backup-heading">
    <div class="section-heading">
      <div>
        <h2 id="backup-heading">备份与迁移</h2>
      </div>
      <ZButton type="primary" :loading="operation === 'preview'" :disabled="!previewAvailable || operation !== null" @click="generatePreview">
        生成导出预览
      </ZButton>
    </div>

    <p v-if="!previewAvailable" class="backup-capability" aria-live="polite">
      当前运行环境尚未提供备份预览能力。
    </p>

    <fieldset class="backup-options" :disabled="!previewAvailable || operation !== null">
      <legend>导出范围</legend>
      <ZCheckbox
        :model-value="options.includeEnvironments"
        @update:model-value="updateEnvironmentInclusion"
      >
        包含环境变量
      </ZCheckbox>
      <div class="backup-options__nested">
        <ZCheckbox
          :model-value="options.includeEnvironmentValues"
          :disabled="!options.includeEnvironments"
          @update:model-value="updateValueInclusion"
        >
          包含环境变量值
        </ZCheckbox>
        <ZCheckbox
          v-model="options.includeSensitiveValues"
          :disabled="!options.includeEnvironments || !options.includeEnvironmentValues"
        >
          包含敏感值
        </ZCheckbox>
      </div>
    </fieldset>

    <p v-if="options.includeSensitiveValues" class="backup-risk" role="status">
      已选择敏感值；生成预览前会要求确认明文风险，确认前不会读取或缓存敏感值。
    </p>

    <p v-if="expired" class="backup-capability" aria-live="polite">预览已过期，请重新生成。</p>

    <article v-if="preview" class="backup-preview" aria-live="polite">
      <div class="backup-preview__heading">
        <div><h3>导出预览</h3><p>预览已生成；保存操作只会写入系统对话框中选择的位置。</p></div>
        <ZTag :type="preview.manifest.options.includeSensitiveValues ? 'warning' : 'info'">
          格式 {{ preview.manifest.formatVersion }}
        </ZTag>
      </div>
      <dl class="backup-summary">
        <div><dt>生成时间</dt><dd>{{ preview.manifest.exportedAt }}</dd></div>
        <div><dt>脚本</dt><dd>{{ preview.manifest.entities.scripts }}</dd></div>
        <div><dt>任务</dt><dd>{{ preview.manifest.entities.tasks }}</dd></div>
        <div><dt>环境变量</dt><dd>{{ preview.manifest.entities.environments }}</dd></div>
        <div><dt>包含变量值</dt><dd>{{ preview.manifest.options.includeEnvironmentValues ? '是' : '否' }}</dd></div>
        <div><dt>包含敏感值</dt><dd>{{ preview.manifest.options.includeSensitiveValues ? '是' : '否' }}</dd></div>
      </dl>
      <ul class="backup-warnings">
        <li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <div class="backup-preview__actions">
        <ZButton type="primary" :loading="operation === 'export'" :disabled="operation !== null" @click="exportBackup">
          导出备份
        </ZButton>
      </div>
    </article>

    <article v-if="exportResult" class="backup-result" aria-live="polite">
      <div class="backup-preview__heading">
        <div><h3>导出完成</h3><p>{{ exportResult.displayName }}</p></div>
        <ZTag :type="exportResult.containsSensitiveValues ? 'warning' : 'success'">
          {{ formatBytes(exportResult.size) }}
        </ZTag>
      </div>
      <p v-if="exportResult.containsSensitiveValues" class="backup-risk backup-result__risk" role="alert">
        此备份包包含本地明文敏感信息。任何能够访问该文件的人都可能读取这些值，请妥善保管并在不再需要时安全删除。
      </p>
      <p v-else class="backup-result__safe">备份包未包含标记为敏感的环境变量值。</p>
    </article>

    <section class="backup-import" aria-labelledby="backup-import-heading">
      <div>
        <h3 id="backup-import-heading">导入校验</h3>
        <p>选择 ZIP 后会在临时目录完整校验，不会修改当前脚本、任务或设置。</p>
      </div>
      <ZButton :loading="operation === 'import-validation'" :disabled="operation !== null" @click="validateImportBackup">
        选择并校验备份
      </ZButton>
      <article v-if="importPreview" class="backup-preview backup-import__preview" aria-live="polite">
        <div class="backup-preview__heading">
          <div><h3>导入内容摘要</h3><p>校验已完成；以下仅为只读预览，尚未修改任何本地数据。</p></div>
          <ZTag :type="importPreview.package.options.includeSensitiveValues ? 'warning' : 'success'">
            格式 {{ importPreview.package.formatVersion }}
          </ZTag>
        </div>
        <dl class="backup-summary">
          <div><dt>导出时间</dt><dd>{{ importPreview.package.exportedAt }}</dd></div>
          <div><dt>应用版本</dt><dd>{{ importPreview.package.appVersion }}</dd></div>
          <div><dt>脚本</dt><dd>{{ importPreview.package.entities.scripts }}</dd></div>
          <div><dt>任务</dt><dd>{{ importPreview.package.entities.tasks }}</dd></div>
          <div><dt>环境变量</dt><dd>{{ importPreview.package.entities.environments }}</dd></div>
          <div><dt>包含敏感值</dt><dd>{{ importPreview.package.options.includeSensitiveValues ? '是' : '否' }}</dd></div>
        </dl>
        <dl class="backup-summary backup-import__modes">
          <div><dt>合并导入</dt><dd>{{ formatImportChanges(importPreview.merge) }}</dd></div>
          <div><dt>覆盖恢复</dt><dd>{{ formatImportChanges(importPreview.overwrite) }}</dd></div>
        </dl>
        <div class="backup-import__mode-actions">
          <ZRadio v-model="importMode" value="merge">合并导入</ZRadio>
          <ZRadio v-model="importMode" value="overwrite">覆盖恢复</ZRadio>
          <ZButton type="primary" :loading="operation === 'import'" :disabled="operation !== null" @click="applyImportBackup">
            {{ importMode === 'merge' ? '应用合并导入' : '应用覆盖恢复' }}
          </ZButton>
        </div>
        <ul class="backup-warnings">
          <li v-for="warning in importPreview.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </article>
      <article v-if="importResult" class="backup-result backup-import__status" aria-live="polite">
        <div class="backup-preview__heading">
          <div><h3>导入完成</h3><p>{{ importResult.mode === 'merge' ? '合并导入' : '覆盖恢复' }}</p></div>
          <ZTag type="success">{{ formatImportChanges(importResult.changes) }}</ZTag>
        </div>
        <ul class="backup-warnings">
          <li v-for="warning in importResult.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </article>
    </section>
  </section>
</template>

<style scoped lang="scss">
.backup-view {
  padding-top: 0;
}

.backup-capability,
.backup-risk {
  margin: 0 0 18px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--info-light-bg);
  color: var(--text-secondary);
  line-height: 1.6;
}

.backup-risk {
  border-left: 3px solid var(--warning-color);
  background: var(--warning-light-bg);
}

.backup-options {
  display: grid;
  gap: 14px;
  margin: 0 0 18px;
  padding: 18px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--card-bg);
}

.backup-options legend {
  padding: 0 6px;
  font-weight: 600;
}

.backup-options__nested {
  display: grid;
  gap: 12px;
  padding-left: 26px;
}

.backup-preview,
.backup-result {
  padding: 20px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--card-bg);
}

.backup-result {
  margin-top: 18px;
}

.backup-warnings {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 20px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.backup-preview__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}

.backup-result__risk {
  margin: 18px 0 0;
  color: var(--text-color);
}

.backup-result__safe {
  margin: 18px 0 0;
  color: var(--text-secondary);
}

.backup-result :deep(.backup-preview__heading p) {
  overflow-wrap: anywhere;
}

.backup-import {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px 20px;
  margin-top: 24px;
  padding: 20px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--card-bg);
}

.backup-import h3,
.backup-import p {
  margin: 0;
}

.backup-import > div p {
  margin-top: 6px;
  color: var(--text-secondary);
}

.backup-import__status,
.backup-import__preview {
  grid-column: 1 / -1;
  margin: 0;
}

.backup-import__modes {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.backup-import__mode-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin: 18px 0;
}
</style>
