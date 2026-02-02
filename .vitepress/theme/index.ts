import DefaultTheme from 'vitepress/theme'
import ColeoHome from './ColeoHome.vue'
import './custom.css'

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('ColeoHome', ColeoHome)
  }
}
