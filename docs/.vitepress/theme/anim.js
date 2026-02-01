// Plain JS home animation bootstrap to avoid Vue render overhead
(function(){
  let state = {
    inited: false,
    raf: 0,
    raysCanvas: null,
    sparklesCanvas: null,
    waterLayer: null,
    depthSlider: null,
    depthControl: null,
    depthIcon: null,
    time: 0,
    brightness: 0.7,
    scrollY: 0,
    docHeight: 0,
    viewportHeight: 0,
    viewportWidth: 0,
    rays: [],
    sparkles: [],
    mouse: { x: 0, y: 0, active: false },
    nextCursorSparkleAt: 0,
    swirls: [],
    streaks: [],
    mouseHistory: [],
    lastDirAngle: 0,
    lastEddySpawnAt: 0,
    lastContinuousSpawnAt: 0,
    nextContinuousSpawnAt: 0,
    newDirectionCooldownUntil: 0,
    mass: { x: 0, y: 0, vx: 0, vy: 0 },
    prevFrameNow: 0,
    lastMoving: null
  }
  const SPARKLE_COUNT=40, MAX_SPARKLES=160
  const ENABLE_BURST=true, MAX_STREAK_SPEED=300
  const STREAK_DRAG_COEFF=0.02, STREAK_FREQ_MIN=12, STREAK_FREQ_MAX=40
  const DRIFT_DRAG_COEFF=0.35, PERP_SEG_DRIFT=20

  function getMouseAngleOver(windowMs, nowTs){
    const cutoff=nowTs-windowMs
    const pts=state.mouseHistory.filter(p=>p.t>=cutoff)
    if(pts.length<2) return null
    let dx=0,dy=0; for(let i=1;i<pts.length;i++){ dx+=pts[i].x-pts[i-1].x; dy+=pts[i].y-pts[i-1].y }
    const mag=Math.hypot(dx,dy); return mag<1e-2?null:Math.atan2(dy,dx)
  }
  function getMouseSpeedOver(windowMs, nowTs){
    const cutoff=nowTs-windowMs
    const pts=state.mouseHistory.filter(p=>p.t>=cutoff)
    if(pts.length<2) return 0
    let dist=0; for(let i=1;i<pts.length;i++){ const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y; dist+=Math.hypot(dx,dy) }
    const dt=(pts[pts.length-1].t-pts[0].t)/1000; return dt<=0?0:dist/dt
  }
  function spawnStreak(x,y,angle,speed){
    const now=performance.now(); const minV=120,maxV=500
    const v=Math.min(maxV,Math.max(minV,speed)); const t=(v-minV)/(maxV-minV)
    const lifetime = 250 + t*(900-250)
    state.streaks.push({ x,y,px:x,py:y, angle, speed, created:now, lifetime })
  }
  function spawnSwirlsAt(centerX,centerY,dirAngle,initSpeed,side,countOverride,opts={}){
    const created=performance.now(), lifetime=2500
    const count=countOverride??10
    const baseAngle=dirAngle, cone=0.35
    for(let i=0;i<count;i++){
      const curlSide=side; const jitter=(Math.random()-0.5)*cone
      const angle=baseAngle+curlSide*0.18+jitter*0.3
      const back=Math.random()*60
      const pathX=centerX-Math.cos(baseAngle)*back, pathY=centerY-Math.sin(baseAngle)*back
      const perp=baseAngle+Math.PI/2, offMag=Math.random()*20
      const offX=Math.cos(perp)*offMag*curlSide, offY=Math.sin(perp)*offMag*curlSide
      const ox=pathX+offX, oy=pathY+offY
      const targetRad=32+Math.random()*10
      state.swirls.push({
        created, lifetime, cx:centerX, cy:centerY,
        cVx: Math.cos(baseAngle)*((initSpeed??200)*0.25), cVy: Math.sin(baseAngle)*((initSpeed??200)*0.25),
        baseAngle, angle, angVel:(1.6+Math.random()*1.6)*curlSide,
        rad: targetRad, radVel: 0, width: 1.5+Math.random()*2.5,
        hue: 190+Math.random()*20, curlStrength:0.35+Math.random()*0.35,
        oscSpeed:2+Math.random()*3, oscPhase:Math.random()*Math.PI*2,
        maxRad: targetRad+14, targetRad,
        forwardTarget: opts.straightDist??0, forwardSpeed:initSpeed??200, forwardDist:0,
        straightX:centerX, straightY:centerY, turned:false, turnedAt:0, baseOmega:0, swirlBurstMs:250,
        dir:curlSide, trail:[{x:ox,y:oy,t:0}], prevTime:created
      })
    }
  }
  function maybeSpawnEddyOnTurn(nowTs){
    const newAngle = getMouseAngleOver(32,nowTs) ?? getMouseAngleOver(64,nowTs)
    if(newAngle==null) return
    const prevAngle=maybeSpawnEddyOnTurn.prevAngle
    if(!prevAngle){ maybeSpawnEddyOnTurn.prevAngle=newAngle; maybeSpawnEddyOnTurn.prevSpeed=getMouseSpeedOver(200,nowTs); return }
    const delta=((newAngle-prevAngle+Math.PI)%(2*Math.PI))-Math.PI
    maybeSpawnEddyOnTurn.prevAngle=newAngle
    const threshold=(40*Math.PI)/180
    const speedNow=getMouseSpeedOver(64,nowTs), speedPrev=maybeSpawnEddyOnTurn.prevSpeed??speedNow
    maybeSpawnEddyOnTurn.prevSpeed=speedNow
    const bigTurn=Math.abs(delta)>=threshold && speedPrev>120
    const bigSlowdown = speedPrev>120 && speedNow<40
    if(!bigTurn && !bigSlowdown) return
    if(nowTs-state.lastEddySpawnAt<250) return
    state.lastEddySpawnAt=nowTs
    const side=delta>0?1:-1
    if(ENABLE_BURST && state.lastMoving){ const sd=60+Math.random()*40; spawnSwirlsAt(state.lastMoving.x,state.lastMoving.y,state.lastMoving.angle,state.lastMoving.speed,side,12,{straightDist:sd}) }
    state.newDirectionCooldownUntil=nowTs+500
  }
  function updateDepth(){ if(!state.depthSlider||!state.depthControl||!state.waterLayer) return
    const value=parseInt(state.depthSlider.value); state.brightness=value/100
    if(state.depthIcon) state.depthIcon.textContent=value>50?'☀️':'🌙'
    state.depthControl.classList.toggle('dark-mode', value<=50)
    const bgBrightness=0.6+state.brightness*0.8, bgSaturation=1.0+state.brightness*0.8
    state.waterLayer.style.filter=`brightness(${bgBrightness}) saturate(${bgSaturation})`
  }
  function init(){
    if(state.inited) return
    state.raysCanvas=document.getElementById('raysCanvas')
    state.sparklesCanvas=document.getElementById('sparklesCanvas')
    state.waterLayer=document.getElementById('waterLayer')
    state.depthSlider=document.getElementById('depthSlider')
    state.depthControl=document.getElementById('depthControl')
    state.depthIcon=document.getElementById('depthIcon')
    if(!state.raysCanvas||!state.sparklesCanvas||!state.waterLayer) return
    state.viewportWidth=window.innerWidth; state.viewportHeight=window.innerHeight; state.docHeight=document.documentElement.scrollHeight
    state.raysCanvas.width=state.viewportWidth; state.raysCanvas.height=state.viewportHeight
    state.sparklesCanvas.width=state.viewportWidth; state.sparklesCanvas.height=state.viewportHeight
    state.rays=[]; for(let i=0;i<8;i++){ state.rays.push({ x:(state.viewportWidth/8)*i+(Math.random()-0.5)*40, y:-200-Math.random()*200, width:120+Math.random()*80, length:state.viewportHeight*1.5, speed:0.1+Math.random()*0.2, phase:Math.random()*Math.PI*2, opacity:0.08+Math.random()*0.1 }) }
    state.sparkles=[]; for(let i=0;i<SPARKLE_COUNT;i++){ state.sparkles.push({ x:Math.random()*state.viewportWidth*2, y:Math.random()*state.docHeight, radius:2+Math.random()*3, speed:0.5+Math.random()*1.0, wobble:Math.random()*Math.PI*2, wobbleSpeed:0.01+Math.random()*0.02, phase:Math.random()*Math.PI*2, maxOpacity:0.4+Math.random()*0.4}) }
    window.addEventListener('resize',()=>{ state.viewportWidth=window.innerWidth; state.viewportHeight=window.innerHeight; state.docHeight=document.documentElement.scrollHeight; state.raysCanvas.width=state.viewportWidth; state.raysCanvas.height=state.viewportHeight; state.sparklesCanvas.width=state.viewportWidth; state.sparklesCanvas.height=state.viewportHeight })
    window.addEventListener('mousemove',(e)=>{ state.mouse.x=e.clientX; state.mouse.y=e.clientY; state.mouse.active=true; const now=performance.now(); state.mouseHistory.push({x:e.clientX,y:e.clientY,t:now}); while(state.mouseHistory.length && (now-state.mouseHistory[0].t)>1000) state.mouseHistory.shift() })
    window.addEventListener('mouseleave',()=>{ state.mouse.active=false })
    window.addEventListener('scroll',()=>{ state.scrollY=window.scrollY; const parallax=-state.scrollY*0.2; state.waterLayer.style.transform=`translate3d(0,${parallax}px,0)`; state.raysCanvas.style.transform=`translate3d(0,${parallax}px,0)` })
    if(state.depthSlider) state.depthSlider.addEventListener('input',updateDepth); updateDepth()
    state.inited=true; animate()
  }
  function animate(){
    const nowTs=performance.now(); const dt=state.prevFrameNow?Math.max(0.001,(nowTs-state.prevFrameNow)/1000):0.016; state.prevFrameNow=nowTs; state.time+=dt
    if(state.raysCanvas){ const ctx=state.raysCanvas.getContext('2d'); ctx.clearRect(0,0,state.viewportWidth,state.viewportHeight); ctx.globalCompositeOperation='screen'; state.rays.forEach(ray=>{ const sway=Math.sin(state.time*ray.speed+ray.phase)*15; const breathing=Math.sin(state.time*0.4+ray.phase)*0.5+0.5; const alpha=ray.opacity*(0.4+state.brightness*0.6)*breathing; if(alpha>0.01){ const startX=ray.x+sway, endX=startX+Math.sin(0.3)*ray.length, endY=ray.y+Math.cos(0.3)*ray.length; const grad=ctx.createLinearGradient(startX,ray.y,endX,endY); grad.addColorStop(0,`rgba(255,255,240,${alpha})`); grad.addColorStop(0.4,`rgba(220,255,250,${alpha*0.6})`); grad.addColorStop(1,`rgba(150,240,255,0)`); ctx.save(); ctx.translate(startX,ray.y); ctx.rotate(0.3); ctx.beginPath(); ctx.moveTo(-ray.width/2,0); ctx.lineTo(ray.width/2,0); ctx.lineTo(ray.width/3,ray.length); ctx.lineTo(-ray.width/3,ray.length); ctx.closePath(); ctx.fillStyle=grad; ctx.fill(); ctx.restore() } }) }
    if(state.sparklesCanvas){ const ctx=state.sparklesCanvas.getContext('2d'); ctx.clearRect(0,0,state.sparklesCanvas.width,state.sparklesCanvas.height); ctx.globalCompositeOperation='source-over'; if(state.mouse.active){ const k=8,damp=Math.max(0,1-4*dt); const mx=state.mouse.x,my=state.scrollY+state.mouse.y; const ax=(mx-state.mass.x)*k, ay=(my-state.mass.y)*k; state.mass.vx=(state.mass.vx+ax*dt)*damp; state.mass.vy=(state.mass.vy+ay*dt)*damp; state.mass.x+=state.mass.vx*dt; state.mass.y+=state.mass.vy*dt }
      const speedNow=getMouseSpeedOver(200,nowTs), angNow=(getMouseAngleOver(200,nowTs) ?? state.lastDirAngle); if(speedNow>120){ state.lastMoving={x:state.mouse.x,y:state.scrollY+state.mouse.y, angle:angNow, speed:speedNow, t:nowTs} }
      maybeSpawnEddyOnTurn(nowTs)
      const SPEED_THRESHOLD=90; if(speedNow>SPEED_THRESHOLD && nowTs>=state.nextContinuousSpawnAt && nowTs>=state.newDirectionCooldownUntil){ const mx=state.mouse.x,my=state.scrollY+state.mouse.y; const streakCount=Math.random()<0.3?2:1; const clampedSpeed=Math.min(MAX_STREAK_SPEED,speedNow); for(let i=0;i<streakCount;i++) spawnStreak(mx,my,angNow,clampedSpeed); const v=Math.min(500,Math.max(SPEED_THRESHOLD,speedNow)); const t=(v-SPEED_THRESHOLD)/(500-SPEED_THRESHOLD); const freq=STREAK_FREQ_MIN+t*(STREAK_FREQ_MAX-STREAK_FREQ_MIN); state.nextContinuousSpawnAt=nowTs+1000/freq; state.lastContinuousSpawnAt=nowTs }
      ctx.save(); ctx.globalCompositeOperation='screen'; let reefRGB=(getComputedStyle(state.waterLayer)).getPropertyValue('--reef-rgb').trim()||'73, 215, 175'
      state.swirls=state.swirls.filter(s=>{ const lifeT=(nowTs-s.created)/s.lifetime; if(lifeT>=1) return false; const dtL=Math.max(0.001,(nowTs-(s.prevTime||nowTs))/1000); s.prevTime=nowTs; const ramp=Math.min(1,(nowTs-s.created)/300); const inStraight=!s.turned&&(s.forwardTarget||0)>0&&(s.forwardDist||0)<(s.forwardTarget||0); let angFric=inStraight?2.0:1.3, radFric=inStraight?0.6:2.2; s.angVel*=Math.max(0,1-angFric*dtL); s.radVel=Math.max(0,s.radVel-radFric*120*dtL); if(!inStraight && !s.turned){ const curlSign=s.dir||1; s.angVel+=curlSign*((s.curlStrength??0.25))*1.0; s.radVel*=0.6; s.turnedAt=nowTs; s.baseOmega=(2.2+Math.random()*1.2)*(s.dir||1); s.cx=s.straightX; s.cy=s.straightY; s.turned=true } let effAng=inStraight?0:s.angVel; if(!inStraight && s.turned){ const swirlAge=nowTs-(s.turnedAt||nowTs); if(swirlAge<(s.swirlBurstMs||250)){ angFric=0.3; const sign=Math.sign(effAng)||Math.sign(s.baseOmega)||1; const minOm=Math.abs(s.baseOmega||2.0); const mag=Math.max(Math.abs(effAng),minOm); effAng=sign*mag; const cap=s.maxRad||38, target=s.targetRad||30; s.rad+=(target-s.rad)*Math.min(1,2*dtL); s.radVel*=Math.max(0,1-3*dtL) } }
        const cap=s.maxRad||28, approach=Math.min(1,(s.rad/cap)), radialFactor=Math.max(0.2,1-approach*0.8)
        const vx0=s.cVx||0, vy0=s.cVy||0; const v0=Math.hypot(vx0,vy0); if(v0>0){ const v1=Math.max(0, v0-DRIFT_DRAG_COEFF*v0*v0*dtL); const scale=v0>0? v1/v0:0; s.cVx=vx0*scale; s.cVy=vy0*scale }
        const prevCx=s.cx||0, prevCy=s.cy||0
        if(inStraight){ const step=(s.forwardSpeed||200)*dtL; s.forwardDist=(s.forwardDist||0)+step; s.straightX+=Math.cos(s.baseAngle||0)*step; s.straightY+=Math.sin(s.baseAngle||0)*step }
        else { s.cx+=(s.cVx||0)*dtL; s.cy+=(s.cVy||0)*dtL; const dtx=(s.cx||0)-prevCx, dty=(s.cy||0)-prevCy; if(Math.abs(dtx)+Math.abs(dty)>0){ for(let k=0;k<s.trail.length;k++){ s.trail[k].x+=dtx; s.trail[k].y+=dty } } const curlSide=s.dir||1; const perpA=(s.baseAngle||0) - curlSide*Math.PI/2; const ux=Math.cos(perpA), uy=Math.sin(perpA); const segDrift=PERP_SEG_DRIFT*dtL; for(let k=0;k<s.trail.length;k++){ s.trail[k].x+=ux*segDrift; s.trail[k].y+=uy*segDrift } }
        s.rad+=s.radVel*dtL*ramp*radialFactor; if(s.rad>cap) s.rad=cap; s.angle+=effAng*dtL*ramp
        const px=inStraight?s.straightX:(s.cx||0)+Math.cos(s.angle)*s.rad, py=inStraight?s.straightY:(s.cy||0)+Math.sin(s.angle)*s.rad
        s.trail.push({x:px,y:py,t:lifeT}); if(s.trail.length>200) s.trail.shift()
        let totalLen=0; for(let i=1;i<s.trail.length;i++){const a=s.trail[i-1],b=s.trail[i]; totalLen+=Math.hypot(b.x-a.x,b.y-a.y)}
        let startIdx=0,acc=0,hideLen=totalLen*0.2; for(let i=1;i<s.trail.length;i++){ const a=s.trail[i-1],b=s.trail[i]; const seg=Math.hypot(b.x-a.x,b.y-a.y); if(acc+seg>=hideLen){ startIdx=i; break } acc+=seg }
        const visibleLen=Math.max(0,totalLen-hideLen)
        if(s.trail.length-startIdx>=2 && visibleLen>0){ let accVis=0; for(let i=startIdx+1;i<s.trail.length;i++){ const a=s.trail[i-1], b=s.trail[i]; const segLen=Math.hypot(b.x-a.x,b.y-a.y); accVis+=segLen; const midFrac=Math.min(1,Math.max(0,(accVis-segLen/2)/visibleLen)); const peak=0.15; const env=1-Math.abs(2*midFrac-1); const timeBias=Math.max(0,1-lifeT*(0.3+0.7*midFrac)); const globalFade=Math.max(0,0.5*(1+Math.cos(Math.PI*lifeT))); const alpha=peak*env*timeBias*globalFade; let nx=b.y-a.y, ny=-(b.x-a.x); const nlen=Math.hypot(nx,ny)||1; nx/=nlen; ny/=nlen; const seed=Math.sin(i*12.9898 + s.created*0.001)*43758.5453; const j=((seed-Math.floor(seed))*2-1)*1.5; const ax=a.x+nx*j, ay=a.y+ny*j, bx=b.x+nx*j, by=b.y+ny*j; const gSeg=ctx.createLinearGradient(ax, ay-state.scrollY, bx, by-state.scrollY); gSeg.addColorStop(0,`rgba(${reefRGB}, 0)`); gSeg.addColorStop(0.5,`rgba(${reefRGB}, ${alpha})`); gSeg.addColorStop(1,`rgba(${reefRGB}, 0)`); ctx.beginPath(); ctx.moveTo(ax, ay-state.scrollY); ctx.lineTo(bx, by-state.scrollY); ctx.strokeStyle=gSeg; ctx.lineWidth=1.2; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.shadowColor=`rgba(${reefRGB}, ${alpha*0.5})`; ctx.shadowBlur=1.5; ctx.stroke() } }
        return true })
      state.streaks=state.streaks.filter(s=>{ const life=nowTs-s.created, t=life/s.lifetime; if(t>=1) return false; s.px=s.x; s.py=s.y; s.speed=Math.max(0, s.speed - STREAK_DRAG_COEFF*s.speed*s.speed*dt); const step=s.speed*dt; s.x+=Math.cos(s.angle)*step; s.y+=Math.sin(s.angle)*step; const dy1=s.py-state.scrollY, dy2=s.y-state.scrollY; ctx.beginPath(); ctx.moveTo(s.px,dy1); ctx.lineTo(s.x,dy2); ctx.strokeStyle=`rgba(255,255,255,${0.40*(1-t)})`; ctx.lineWidth=1.25; ctx.lineCap='round'; ctx.stroke(); return true })
      ctx.restore()
    }
    state.raf=requestAnimationFrame(animate)
  }
  function initHomeAnimation(){ if(typeof window==='undefined') return; init() }
  function stopHomeAnimation(){ if(state.raf) cancelAnimationFrame(state.raf); state.inited=false }
  window.__homeAnim={ initHomeAnimation, stopHomeAnimation }
})();
