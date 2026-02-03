// Lightweight inner-pages background: water gradient + light rays + depth slider
(function(){
  const DBG = (...args) => { try { console.log('[innerAnim]', ...args) } catch(_){} }
  let state = {
    inited:false, raf:0,
    water:null, waterFx:null, raysCanvas:null,
    depthCtrl:null, depthSlider:null, depthIcon:null,
    viewportWidth:0, viewportHeight:0, scrollY:0,
    brightness:0.7, time:0, prevFrameNow:0,
    rays:[],
    resizeHandler:null, scrollHandler:null, inputHandler:null,
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
    if(!document.getElementById('depthControlInner')){
      const d=document.createElement('div'); d.id='depthControlInner'; d.className='depth-control'; d.dataset.inner='1'
      const label=document.createElement('label')
      const icon=document.createElement('span'); icon.id='depthIconInner'; icon.textContent='☀️'
      label.appendChild(icon)
      const input=document.createElement('input'); input.type='range'; input.id='depthSliderInner'; input.min='0'; input.max='100'; input.value='70'
      d.appendChild(label); d.appendChild(input)
      document.body.appendChild(d)
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
    state.depthCtrl=document.getElementById('depthControlInner')
    state.depthSlider=document.getElementById('depthSliderInner')
    state.depthIcon=document.getElementById('depthIconInner')
  }

  function updateDepth(){ if(!state.depthSlider||!state.waterFx||!state.depthCtrl) return
    const value=parseInt(state.depthSlider.value||'70',10); state.brightness=value/100
    if(state.depthIcon) state.depthIcon.textContent=value>50?'☀️':'🌙'
    const isLight=value>50
    state.depthCtrl.classList.toggle('dark-mode', !isLight)
    // Mirror mode globally so navbar/content can restyle
    document.body.classList.toggle('light-mode', isLight)
    document.body.classList.toggle('dark-mode', !isLight)
    const bgBrightness=0.6+state.brightness*0.8, bgSaturation=1.0+state.brightness*0.8
    // Apply brightness/saturation to wrapper to avoid overwriting `.water-layer` filter.
    state.waterFx.style.filter=`brightness(${bgBrightness}) saturate(${bgSaturation})`
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
    state.raysCanvas.width=state.viewportWidth; state.raysCanvas.height=Math.floor(state.viewportHeight*1.5)
    initRays(); updateDepth()
    state.resizeHandler=()=>{ state.viewportWidth=window.innerWidth; state.viewportHeight=window.innerHeight; state.raysCanvas.width=state.viewportWidth; state.raysCanvas.height=Math.floor(state.viewportHeight*1.5); initRays() }
    state.scrollHandler=()=>{ state.scrollY=window.scrollY; const parallax=-state.scrollY*0.2; state.water.style.transform=`translate3d(0,${parallax}px,0)`; state.raysCanvas.style.transform=`translate3d(0,${parallax}px,0)` }
    state.inputHandler=()=>updateDepth()
    if(state.depthIcon){
      state.depthIcon.style.cursor='pointer'
      state.iconClickHandler=()=>{
        const val=parseInt(state.depthSlider.value||'70',10)
        state.depthSlider.value = val>50 ? '30' : '80'
        updateDepth()
      }
      state.depthIcon.addEventListener('click', state.iconClickHandler)
    }
    window.addEventListener('resize', state.resizeHandler)
    window.addEventListener('scroll', state.scrollHandler)
    if(state.depthSlider) state.depthSlider.addEventListener('input', state.inputHandler)
    state.inited=true; DBG('initInner complete')
    animate()
  }

  function stopInner(){ DBG('stopInner')
    if(state.raf){ cancelAnimationFrame(state.raf); state.raf=0 }
    if(state.resizeHandler){ window.removeEventListener('resize', state.resizeHandler); state.resizeHandler=null }
    if(state.scrollHandler){ window.removeEventListener('scroll', state.scrollHandler); state.scrollHandler=null }
    if(state.inputHandler && state.depthSlider){ state.depthSlider.removeEventListener('input', state.inputHandler); state.inputHandler=null }
    if(state.depthIcon && state.iconClickHandler){ state.depthIcon.removeEventListener('click', state.iconClickHandler); state.iconClickHandler=null }
    // remove only elements we created
    const ids=['waterLayerInner','raysCanvasInner','depthControlInner']
    for(const id of ids){ const el=document.getElementById(id); if(el && el.dataset && el.dataset.inner==='1'){ try{ el.remove() }catch(_){} } }
    state.inited=false; state.rays=[]; state.water=null; state.raysCanvas=null; state.depthCtrl=null; state.depthSlider=null; state.depthIcon=null
  }

  window.__innerAnim={ initInnerAnimation:initInner, stopInnerAnimation:stopInner }
})()
