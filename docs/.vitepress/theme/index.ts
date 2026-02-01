import DefaultTheme from 'vitepress/theme'
import Layout from './layout/Layout.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    if (typeof window !== 'undefined') {
      const boot = () => { setTimeout(async () => { try { await import('./anim.js') } catch (e) {} ; (window).__homeAnim && (window).__homeAnim.initHomeAnimation && (window).__homeAnim.initHomeAnimation() }, 0) }
      boot()
      const r = router
      if (r && typeof (r).onAfterRouteChanged === 'function') {
        (r).onAfterRouteChanged(boot)
      } else {
        app.mixin({ mounted: boot, updated: boot })
        window.addEventListener('popstate', boot)
        window.addEventListener('hashchange', boot)
      }
    }
  }
}

