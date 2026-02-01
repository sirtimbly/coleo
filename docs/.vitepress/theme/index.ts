import DefaultTheme from 'vitepress/theme'
import Layout from './layout/Layout.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    if (typeof window !== 'undefined') {
      const isHomePath = () => {
        const p = location.pathname || '/'
        return p === '/' || p.endsWith('/index.html')
      }
      const boot = () => {
        setTimeout(async () => {
          const home = isHomePath()
          console.log('[theme] boot start', { path: location.pathname, home, ts: Date.now() })
          // Stop both animators before starting the appropriate one
          ;(window as any).__homeAnim?.stopHomeAnimation?.()
          ;(window as any).__innerAnim?.stopInnerAnimation?.()
          if (home) {
            try { await import('./anim.js') } catch (_) {}
            ;(window as any).__homeAnim?.initHomeAnimation?.()
            console.log('[theme] boot end (home)', { hasAnim: !!(window as any).__homeAnim })
          } else {
            try { await import('./anim-lite.js') } catch (_) {}
            ;(window as any).__innerAnim?.initInnerAnimation?.()
            console.log('[theme] boot end (inner)', { hasAnim: !!(window as any).__innerAnim })
          }
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
