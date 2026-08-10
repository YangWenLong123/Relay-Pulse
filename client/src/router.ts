import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import CodexAccountsWorkspaceView from './views/CodexAccountsWorkspaceView.vue';
import DrawingWorkspaceView from './views/DrawingWorkspaceView.vue';
import PoolWorkspaceView from './views/PoolWorkspaceView.vue';
import PlaygroundWorkspaceView from './views/PlaygroundWorkspaceView.vue';
import PurityWorkspaceView from './views/PurityWorkspaceView.vue';
import { isExtensionProtocol } from './utils/runtime';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;

export const router = createRouter({
  history: isExtensionProtocol(runtimeProtocol) ? createWebHashHistory() : createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/usage', name: 'usage-records', component: PoolWorkspaceView },
    { path: '/codex-accounts', name: 'codex-accounts', component: CodexAccountsWorkspaceView },
    { path: '/playground', name: 'playground', component: PlaygroundWorkspaceView },
    { path: '/drawing', name: 'drawing-workspace', component: DrawingWorkspaceView },
    { path: '/purity', name: 'purity-test', component: PurityWorkspaceView }
  ]
});
