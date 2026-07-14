<script setup lang="ts">
import type { RunStatus } from '../types/domain'

const props = defineProps<{ status: RunStatus; size?: 'small' | 'medium' | 'large' }>()
const statusMeta: Record<RunStatus, { label: string; type: 'info' | 'primary' | 'success' | 'danger' | 'warning' }> = {
  starting: { label: '启动中', type: 'info' },
  running: { label: '运行中', type: 'primary' },
  success: { label: '成功', type: 'success' },
  failed: { label: '失败', type: 'danger' },
  timed_out: { label: '已超时', type: 'warning' },
  stopped: { label: '已停止', type: 'info' },
  interrupted: { label: '异常中断', type: 'danger' }
}
</script>

<template>
  <ZTag :type="statusMeta[props.status].type" :size="props.size ?? 'small'" round>
    {{ statusMeta[props.status].label }}
  </ZTag>
</template>
