import DefaultTheme from 'vitepress/theme'
import Layout from './layout/Layout.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    if (typeof window !== 'undefined') {
      const boot = () => {
        setTimeout(async () => {
          console.log('[theme] boot start', { path: location.pathname, ts: Date.now() })
          try { await import('./anim.js') } catch (_) {}
          // Ensure previous loop/listeners are cleared, then attempt init after content renders.
          (window as any).__homeAnim?.stopHomeAnimation?.()
          ;(window as any).__homeAnim?.initHomeAnimation?.()
          console.log('[theme] boot end', { hasAnim: !!(window as any).__homeAnim })
        }, 0)
      }
      boot()
      const r: any = router
      if (r && typeof r.onAfterRouteChanged === 'function') {
        r.onAfterRouteChanged(() => {
          console.log('[theme] route changed')
          boot()
        })
      }
    }
  }
}
