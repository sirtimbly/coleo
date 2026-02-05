import DefaultTheme from 'vitepress/theme'
import Layout from './layout/Layout.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp() {}
}
