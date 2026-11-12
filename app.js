const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const API=(window.API_BASE||'').replace(/\/$/,'');
const j=async u=>{const r=await fetch(API+u),d=await r.json();if(!r.ok)throw Error(d.error||r.status);return d};
const store=(k,v)=>{try{if(v===undefined)return JSON.parse(localStorage.getItem(k));localStorage.setItem(k,JSON.stringify(v))}catch{}};
const eta=s=>s==null?'—':s<60?'< 1 min':Math.round(s/60)+' min';
const dly=s=>s==null?['—','']:(m=>[(s>=0?'+':'−')+m+' min',s>=120?'bad':s<=-120?'warn':'ok'])(Math.round(Math.abs(s)/60));

const map=L.map('map').setView([32.66,-16.93],12);
L.tileLayer(API+'/tiles/{z}/{x}/{y}.png',{tileSize:512,zoomOffset:-1,maxZoom:20,attribution:'&copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'}).addTo(map);
const Loc=L.Control.extend({onAdd(){const b=L.DomUtil.create('button','leaflet-bar');b.textContent='◎';b.title='A minha localização';b.setAttribute('aria-label',b.title);b.style.cssText='width:34px;height:34px;background:#fff;border:0;font-size:18px;cursor:pointer';b.onclick=e=>{e.stopPropagation();map.locate({setView:true,maxZoom:16})};return b}});new Loc({position:'topleft'}).addTo(map);
let me;map.on('locationfound',e=>{me&&me.remove();me=L.circleMarker(e.latlng,{radius:7,color:'#fff',weight:3,fillColor:'#1a73e8',fillOpacity:1}).addTo(map)});
map.createPane('buses').style.zIndex=660; // acima das etiquetas das paragens (650), abaixo dos popups (700)
const G={shapes:L.layerGroup().addTo(map),stops:L.layerGroup().addTo(map),buses:L.layerGroup().addTo(map)};
let lines=[],sel=new Set(store('sel')||['04']),stopMarks=[],busMarks=new Map(),vehicles=[],fitted=false;

// ---- linhas
function chips(){const f=$('#q').value.toLowerCase();
  $('#chips').innerHTML='';
  lines.filter(l=>!f||(l.id+' '+l.name).toLowerCase().includes(f)).forEach(l=>{
    const b=document.createElement('button');b.className='chip'+(sel.has(l.id)?' on':'');b.style.setProperty('--c',l.color);
    b.textContent=l.id;b.title=l.name;b.onclick=()=>{sel.has(l.id)?sel.delete(l.id):sel.add(l.id);store('sel',[...sel]);fitted=false;chips();draw();refresh()};
    $('#chips').append(b)})}
$('#q').oninput=chips;

// ---- percursos e paragens (com número + nome)
async function draw(){
  G.shapes.clearLayers();G.stops.clearLayers();stopMarks=[];const seen=new Set(),bounds=[];
  const color=Object.fromEntries(lines.map(l=>[l.id,l.color]));
  for(const id of sel){let d;try{d=await j('/api/line?line='+encodeURIComponent(id))}catch(e){status(e.message,1);continue}
    d.patterns.forEach((p,i)=>{
      if(p.shape.length){L.polyline(p.shape,{color:color[id]||'#8CC641',weight:4,opacity:.65,dashArray:i%2?'8 6':null}).addTo(G.shapes);bounds.push(...p.shape)}
      p.stops.forEach(s=>{if(seen.has(s.id))return;seen.add(s.id);
        const m=L.circleMarker([s.lat,s.lon],{radius:5,weight:2,color:color[id]||'#8CC641',fillColor:'#fff',fillOpacity:1}).addTo(G.stops);
        m.s=s;m.bindPopup('',{maxWidth:320}).on('popupopen',()=>stopPopup(m));stopMarks.push(m)})})}
  labels();if(bounds.length&&!fitted){map.fitBounds(bounds,{padding:[30,30]});fitted=true}}
function labels(){const z=map.getZoom(),big=z>=16;if(z<(sel.size>3?14:12))map.hasLayer(G.stops)&&map.removeLayer(G.stops);else map.hasLayer(G.stops)||G.stops.addTo(map);stopMarks.forEach(m=>{m.unbindTooltip().bindTooltip(esc(m.s.num)+' · '+esc(m.s.name),{permanent:big,direction:'right',offset:[6,0],className:'stl'})})}
map.on('zoomend',labels);

async function stopPopup(m){const s=m.s,h=`<div class="pop"><h3>${esc(s.num)} · ${esc(s.name)}</h3>`;m.setPopupContent(h+'A carregar…</div>');
  try{const a=(await j('/api/stop?id='+s.id)).slice(0,10);
    m.setPopupContent(h+(a.length?a.map(x=>{const[dt,c]=dly(x.delay);return`<div class="arr"><span class="badge" style="--c:${x.color}">${esc(x.short)}</span><span>${esc(x.headsign)}<br><span class="sub">programado ${esc(x.sched)}${x.live?` · <span class="${c}">${dt}</span>`:' · sem GPS'}</span></span><b class="num">${x.live?(x.atStop?'na paragem':eta(x.eta)):esc(x.display)}</b></div>`}).join(''):'Sem passagens previstas.')+'</div>')}
  catch(e){m.setPopupContent(h+esc(e.message)+'</div>')}}

// ---- autocarros
function busHtml(v){const[dt,c]=dly(v.delay),pct=v.total?Math.max(0,Math.min(100,(v.idx+1)/v.total*100)):0;
  const kind=v.depKind==='observada'?'calculada pela passagem observada':v.depKind==='estimada'?'programada + atraso atual':'';
  return`<div class="pop" style="--c:${v.color}"><h3>Linha ${esc(v.line)} · autocarro ${v.vehicle}</h3><table>
  <tr><td>Sentido</td><td><b>${esc(v.headsign)}</b></td></tr>
  <tr><td>Velocidade</td><td class="num">${v.speed==null?'a calcular…':v.speed+' km/h'} <span class="sub">(estimada)</span></td></tr>
  <tr><td>Chega a ${esc(v.destNum)}</td><td class="num"><b>${eta(v.etaDest)}</b> · prev. ${esc(v.displayDest)}</td></tr>
  <tr><td>Hora programada</td><td class="num">${esc(v.schedDest)}</td></tr>
  <tr><td>Atraso</td><td class="${c}">${dt}</td></tr>
  <tr><td>Saiu (programado)</td><td class="num">${esc(v.depSched||'—')}</td></tr>
  <tr><td>Saiu (real)</td><td class="num">${esc(v.depReal||'—')} <span class="sub">${kind}</span></td></tr>
  <tr><td>Última paragem</td><td>${v.last?esc(v.last.num)+' · '+esc(v.last.name):'—'}</td></tr></table>
  <div class="bar" style="--c:${v.color}"><i style="width:${pct}%"></i></div><div class="sub">paragem ${v.idx+1} de ${v.total}</div></div>`}

function drawBuses(vs){vehicles=vs;const sc=$('#list').scrollTop;const keep=new Set();
  vs.forEach(v=>{const k=v.vehicle+'|'+v.line;keep.add(k);const icon=L.divIcon({className:'bus-m',iconSize:[0,0],html:`<div class="bus" style="--c:${v.color}">${esc(v.short)} <small>${v.vehicle}</small></div>`});
    let m=busMarks.get(k);if(!m){m=L.marker([v.lat,v.lon],{icon,pane:'buses',zIndexOffset:1000}).bindPopup('',{maxWidth:340}).addTo(G.buses);busMarks.set(k,m)}
    m.setLatLng([v.lat,v.lon]);m.v=v;m.getPopup().setContent(busHtml(v))});
  for(const[k,m]of busMarks)if(!keep.has(k)){G.buses.removeLayer(m);busMarks.delete(k)}
  $('#list').innerHTML=vs.length?'':'<div class="empty">Sem autocarros com GPS neste momento nas linhas escolhidas.</div>';
  vs.forEach(v=>{const[dt,c]=dly(v.delay),d=document.createElement('div');d.className='card';d.tabIndex=0;d.style.setProperty('--c',v.color);
    d.innerHTML=`<span class="badge">${esc(v.short)}</span><b>${esc(v.headsign)}</b><span class="big num">${eta(v.etaDest)}</span>
    <span class="sub">nº ${v.vehicle} · ${v.speed==null?'—':v.speed+' km/h'} · <span class="${c}">${dt}</span> · prog. ${esc(v.schedDest)}</span><span class="sub">a ${esc(v.destNum)}</span>`;
    const go=()=>{const m=busMarks.get(v.vehicle+'|'+v.line);map.flyTo(m.getLatLng(),Math.max(map.getZoom(),15));m.openPopup()};
    d.onclick=go;d.onkeydown=e=>e.key==='Enter'&&go();$('#list').append(d)});$('#list').scrollTop=sc}

function status(t,err){const s=$('#st');s.textContent=t;s.className=err?'err':''}
let busy=false;
async function refresh(){if(busy)return;if(!sel.size){drawBuses([]);$('#list').innerHTML='<div class="empty">Escolhe uma ou mais linhas.</div>';status('Sem linhas escolhidas');return}
  busy=true;try{const d=await j('/api/vehicles?lines='+[...sel].join(','));drawBuses(d.vehicles);status(`${d.vehicles.length} autocarros · atualizado às ${d.at} · a cada 10 s${sel.size>6?' (muitas linhas: só destinos)':''}`)}
  catch(e){status('Erro: '+e.message,1)}busy=false}

(async()=>{try{lines=await j('/api/lines');chips();await draw();refresh();setInterval(()=>document.hidden||refresh(),10000);document.addEventListener('visibilitychange',()=>document.hidden||refresh())}catch(e){status('Erro: '+e.message+' — o servidor está a correr?',1)}})();
