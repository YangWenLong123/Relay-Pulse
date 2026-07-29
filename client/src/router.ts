import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import { isExtensionProtocol } from './utils/runtime';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;

export const router = createRouter({
  history: isExtensionProtocol(runtimeProtocol) ? createWebHashHistory() : createWebHistory(),
  routes: [{ path: '/', name: 'dashboard', component: DashboardView }]
});
