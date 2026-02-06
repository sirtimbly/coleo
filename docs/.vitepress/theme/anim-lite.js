// Lightweight inner-pages background: water gradient + light rays + depth slider
(function(){
  const DBG = (...args) => { try { console.log('[innerAnim]', ...args) } catch(_){} }
  let state = {
    inited:false, raf:0,
    water:null, waterFx:null, raysCanvas:null,
    depthCtrl:null, depthSlider:null, depthIcon:null,
    viewportWidth:0, viewportHeight:0, scrollY:0, docHeight:0,
    brightness:0.7, time:0, prevFrameNow:0,
    rays:[],
    resizeHandler:null, scrollHandler:null, inputHandler:null,
    colorSchemeQuery:null, colorSchemeHandler:null,
    depthRetry:0, depthRetryTimer:null, depthBound:false, iconClickHandler:null,
  }

  function getDocumentHeight(){
    const de=document.documentElement
    const body=document.body
    return Math.max(
      de ? de.scrollHeight : 0,
      de ? de.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
    )
  }

  function syncInnerLayerSizing(){
    if(!state.water || !state.raysCanvas) return
    state.docHeight=getDocumentHeight()
    const maxScroll=Math.max(0, state.docHeight-state.viewportHeight)
    const parallaxTravel=Math.ceil(maxScroll*0.2)
    const overscanTop=Math.ceil(state.viewportHeight*0.25)
    const layerHeight=Math.ceil(state.viewportHeight+overscanTop+parallaxTravel+64)
    const top=`-${overscanTop}px`
    const height=`${layerHeight}px`

    if(state.waterFx){
      state.waterFx.style.top=top
      state.waterFx.style.height=height
    }
    state.water.style.top=top
    state.water.style.height=height
    state.raysCanvas.style.top=top
    state.raysCanvas.style.height=height
    state.raysCanvas.width=state.viewportWidth
    state.raysCanvas.height=layerHeight
  }

  function getSystemIsLight(){
    try{
      if(window.matchMedia){
        return window.matchMedia('(prefers-color-scheme: light)').matches
      }
    }catch(_){}
    return true
  }

  function ensureDom(){
    // Create only if not already present; tag with data-inner
    if(!document.getElementById('waterFxInner')){
      const wfx=document.createElement('div'); wfx.id='waterFxInner'; wfx.className='water-fx-layer'; wfx.dataset.inner='1'; document.body.appendChild(wfx)
    }
    if(!document.getElementById('waterLayerInner')){
      const w=document.createElement('div'); w.id='waterLayerInner'; w.className='water-layer'; w.dataset.inner='1'; document.body.appendChild(w)
    }
    if(!document.getElementById('raysCanvasInner')){
      const c=document.createElement('canvas'); c.id='raysCanvasInner'; c.className='rays-layer'; c.dataset.inner='1'; document.body.appendChild(c)
    }
    state.waterFx=document.getElementById('waterFxInner')
    state.water=document.getElementById('waterLayerInner')
    // Move water layer into the wrapper so the wrapper filter affects it.
    try {
      if(state.waterFx && state.water && state.water.parentElement !== state.waterFx){
        state.waterFx.appendChild(state.water)
      }
    } catch(_){}
    state.raysCanvas=document.getElementById('raysCanvasInner')
  }

  function resolveDepthControl(){
    state.depthCtrl=document.getElementById('depthControl')
    state.depthSlider=document.getElementById('depthSlider')
    state.depthIcon=document.getElementById('depthIcon')
    return !!(state.depthCtrl && state.depthSlider)
  }

  function updateDepth(){ if(!state.depthSlider||!state.waterFx||!state.depthCtrl) return
    const value=parseInt(state.depthSlider.value||'70',10); state.brightness=value/100
    if(state.depthIcon) state.depthIcon.textContent='💡'
    const isLight=value>50
    state.depthCtrl.classList.toggle('dark-mode', !isLight)
    // Mirror mode globally so navbar/content can restyle
    document.body.classList.toggle('light-mode', isLight)
    document.body.classList.toggle('dark-mode', !isLight)
    const bgBrightness=0.6+state.brightness*0.8, bgSaturation=1.0+state.brightness*0.8
    // Apply brightness/saturation to wrapper to avoid overwriting `.water-layer` filter.
    state.waterFx.style.filter=`brightness(${bgBrightness}) saturate(${bgSaturation})`
  }

  function bindDepthControl(){
    if(state.depthBound) return
    if(!resolveDepthControl()){
      if(state.depthRetry < 20){
        state.depthRetry++
        state.depthRetryTimer=setTimeout(bindDepthControl,50)
      }
      return
    }
    state.inputHandler=()=>updateDepth()
    if(state.depthSlider) state.depthSlider.addEventListener('input', state.inputHandler)
    if(state.depthIcon){
      state.depthIcon.style.cursor='pointer'
      state.iconClickHandler=()=>{
        const val=parseInt(state.depthSlider.value||'70',10)
        state.depthSlider.value = val>50 ? '30' : '80'
        updateDepth()
      }
      state.depthIcon.addEventListener('click', state.iconClickHandler)
    }
    if(window.matchMedia){
      state.colorSchemeQuery = window.matchMedia('(prefers-color-scheme: light)')
      state.colorSchemeHandler = (event)=>{ if(!state.depthSlider) return; state.depthSlider.value = event.matches ? '70' : '30'; updateDepth() }
      if(state.colorSchemeQuery.addEventListener){
        state.colorSchemeQuery.addEventListener('change', state.colorSchemeHandler)
      } else if(state.colorSchemeQuery.addListener){
        state.colorSchemeQuery.addListener(state.colorSchemeHandler)
      }
    }
    applySystemPreference()
    state.depthBound=true
  }

  function applySystemPreference(){
    if(!state.depthSlider) return
    state.depthSlider.value = getSystemIsLight() ? '70' : '30'
    updateDepth()
  }

  function initRays(){
    state.rays=[]
    const vw=state.viewportWidth, vh=(state.raysCanvas?.height||state.viewportHeight)
    for(let i=0;i<8;i++){
      state.rays.push({ x:(vw/8)*i+(Math.random()-0.5)*40, y:-200-Math.random()*200, width:120+Math.random()*80, length:vh*1.2, speed:0.1+Math.random()*0.2, phase:Math.random()*Math.PI*2, opacity:0.08+Math.random()*0.1 })
    }
  }

  function drawRays(dt){
    const ctx=state.raysCanvas.getContext('2d')
    ctx.clearRect(0,0,state.raysCanvas.width,state.raysCanvas.height)
    ctx.globalCompositeOperation='screen'
    const t=state.time
    for(let i=0;i<state.rays.length;i++){
      const ray=state.rays[i]
      const sway=Math.sin(t*ray.speed+ray.phase)*15
      const breathing=Math.sin(t*0.4+ray.phase)*0.5+0.5
      const alpha=ray.opacity*(0.4+state.brightness*0.6)*breathing
      if(alpha<=0.01) continue
      const startX=ray.x+sway, endX=startX+Math.sin(0.3)*ray.length, endY=ray.y+Math.cos(0.3)*ray.length
      const grad=ctx.createLinearGradient(startX,ray.y,endX,endY)
      grad.addColorStop(0,`rgba(255,255,240,${alpha})`)
      grad.addColorStop(0.4,`rgba(220,255,250,${alpha*0.6})`)
      grad.addColorStop(1,`rgba(150,240,255,0)`)
      ctx.save(); ctx.translate(startX,ray.y); ctx.rotate(0.3)
      ctx.beginPath(); ctx.moveTo(-ray.width/2,0); ctx.lineTo(ray.width/2,0); ctx.lineTo(ray.width/3,ray.length); ctx.lineTo(-ray.width/3,ray.length); ctx.closePath()
      ctx.fillStyle=grad; ctx.fill(); ctx.restore()
    }
  }

  function animate(){ if(!state.inited) return
    const now=performance.now(); const dt=state.prevFrameNow?Math.max(0.001,(now-state.prevFrameNow)/1000):0.016; state.prevFrameNow=now; state.time+=dt
    if(state.raysCanvas) drawRays(dt)
    state.raf=requestAnimationFrame(animate)
  }

  function initInner(){
    if(state.inited) return
    ensureDom()
    if(!state.water||!state.raysCanvas) return
    state.viewportWidth=window.innerWidth; state.viewportHeight=window.innerHeight
    syncInnerLayerSizing()
    initRays(); bindDepthControl()
    state.resizeHandler=()=>{
      state.viewportWidth=window.innerWidth
      state.viewportHeight=window.innerHeight
      syncInnerLayerSizing()
      initRays()
    }
    state.scrollHandler=()=>{
      state.scrollY=window.scrollY
      const latestDocHeight=getDocumentHeight()
      if(Math.abs(latestDocHeight-state.docHeight)>4){
        syncInnerLayerSizing()
        initRays()
      }
      const parallax=-state.scrollY*0.2
      state.water.style.transform=`translate3d(0,${parallax}px,0)`
      state.raysCanvas.style.transform=`translate3d(0,${parallax}px,0)`
    }
    window.addEventListener('resize', state.resizeHandler)
    window.addEventListener('scroll', state.scrollHandler)
    state.inited=true; DBG('initInner complete')
    animate()
  }

  function stopInner(){ DBG('stopInner')
    if(state.raf){ cancelAnimationFrame(state.raf); state.raf=0 }
    if(state.resizeHandler){ window.removeEventListener('resize', state.resizeHandler); state.resizeHandler=null }
    if(state.scrollHandler){ window.removeEventListener('scroll', state.scrollHandler); state.scrollHandler=null }
    if(state.inputHandler && state.depthSlider){ state.depthSlider.removeEventListener('input', state.inputHandler); state.inputHandler=null }
    if(state.depthIcon && state.iconClickHandler){ state.depthIcon.removeEventListener('click', state.iconClickHandler); state.iconClickHandler=null }
    if(state.colorSchemeQuery && state.colorSchemeHandler){
      if(state.colorSchemeQuery.removeEventListener){
        state.colorSchemeQuery.removeEventListener('change', state.colorSchemeHandler)
      } else if(state.colorSchemeQuery.removeListener){
        state.colorSchemeQuery.removeListener(state.colorSchemeHandler)
      }
      state.colorSchemeQuery=null; state.colorSchemeHandler=null
    }
    if(state.depthRetryTimer){ clearTimeout(state.depthRetryTimer); state.depthRetryTimer=null }
    state.depthRetry=0; state.depthBound=false
    // remove only elements we created
    const ids=['waterLayerInner','raysCanvasInner']
    for(const id of ids){ const el=document.getElementById(id); if(el && el.dataset && el.dataset.inner==='1'){ try{ el.remove() }catch(_){} } }
    state.inited=false; state.rays=[]; state.water=null; state.raysCanvas=null; state.depthCtrl=null; state.depthSlider=null; state.depthIcon=null
  }

  window.__innerAnim={ initInnerAnimation:initInner, stopInnerAnimation:stopInner }
})()
