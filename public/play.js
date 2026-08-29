const socket=io();
const $=id=>document.getElementById(id);
let room=null,myName='',activeMoles=[];
const params=new URLSearchParams(location.search);
if(params.get('room'))$('roomId').value=params.get('room');

function fmt(ms){if(ms==null||ms<0)return '00:00';const s=Math.ceil(ms/1000),m=Math.floor(s/60),r=s%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`}
function escapeHtml(s){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function diffLabel(d){return ({easy:'簡易版',medium:'中級版',hard:'困難版'})[d]||d}

socket.on('connect',()=>{$('conn').textContent='🟢 已連線'});
socket.on('disconnect',()=>{$('conn').textContent='🔴 已斷線'});
socket.on('player:joined',({name,room:r})=>{myName=name;room=r;$('joinCard').classList.add('hidden');$('gameArea').classList.remove('hidden');renderAll()});
socket.on('room:update',r=>{room=r;activeMoles=r.activeMoles||[];renderAll()});
socket.on('moles:update',m=>{activeMoles=m;renderGrid()});
socket.on('game:countdown',n=>{$('countdown').textContent=n;$('countdown').classList.remove('hidden')});
socket.on('game:started',()=>{$('countdown').classList.add('hidden')});
socket.on('game:finished',()=>{$('countdown').classList.add('hidden')});
socket.on('hit:success',({index,points})=>showHitEffect(index,points));

$('joinBtn').addEventListener('click',()=>{
  const roomId=$('roomId').value.trim(),name=$('playerName').value.trim();
  if(!roomId||!name){alert('請輸入場次號碼與玩家名稱');return}
  socket.emit('player:join',{roomId,name});
});

function renderAll(){if(!room)return;renderInfo();renderGrid();renderRank()}
function renderInfo(){
  $('sessionText').textContent=room.sessionNo;
  const me=room.players.find(p=>p.name===myName);
  $('scoreText').textContent=me?me.score:0;
  $('rankText').textContent=me?`第 ${me.rank} 名`:'-';
  $('noteText').textContent=room.note?`📝 ${room.note}`:'';
  const labels={waiting:'等待主控開始',scheduled:'已預約開賽',countdown:'準備開始！',playing:`🔥 遊戲進行中｜${diffLabel(room.difficulty)}`,finished:'🏁 遊戲結束'};
  $('statusText').textContent=labels[room.status]||room.status;
  if(room.status==='countdown'){$('countdown').textContent=room.countdown||room.countdownSec||30;$('countdown').classList.remove('hidden')}else{$('countdown').classList.add('hidden')}
}
function renderGrid(){
  if(!room)return;const grid=$('moleGrid');grid.style.gridTemplateColumns=`repeat(${room.grid},1fr)`;
  const total=room.grid*room.grid;if(grid.children.length!==total){grid.innerHTML='';for(let i=0;i<total;i++){const b=document.createElement('button');b.type='button';b.className='hole';b.dataset.index=i;b.setAttribute('aria-label',`地鼠洞 ${i+1}`);b.addEventListener('click',()=>hit(i,b));grid.appendChild(b)}}
  [...grid.children].forEach((b,i)=>{b.innerHTML=activeMoles.includes(i)?'<span class="mole">🐹</span>':'';b.disabled=room.status!=='playing'||!activeMoles.includes(i)});
}
function hit(i,b){if(!room||room.status!=='playing'||!activeMoles.includes(i))return;socket.emit('player:hit',{index:i})}
function showHitEffect(i,points=1){
  const b=$('moleGrid').children[i];
  if(!b)return;

  // 效果放在 body 上，不會被即時排行榜/地鼠更新洗掉
  const rect=b.getBoundingClientRect();
  const fx=document.createElement('div');
  fx.className='hit-fx';
  fx.style.left=`${rect.left+rect.width/2}px`;
  fx.style.top=`${rect.top+rect.height/2}px`;
  fx.innerHTML=`<span class="hit-boom">💥</span><span class="hit-plus">+${points}</span>`;
  document.body.appendChild(fx);

  b.classList.add('hit-flash');
  setTimeout(()=>b.classList.remove('hit-flash'),420);
  setTimeout(()=>fx.remove(),850);
}

function renderRank(){const box=$('ranking');box.innerHTML='';room.players.forEach(p=>{const row=document.createElement('div');row.className='rank-row'+(p.name===myName?' me':'');row.innerHTML=`<div class="rank">${p.rank<=3?['🥇','🥈','🥉'][p.rank-1]:p.rank}</div><div>${escapeHtml(p.name)}</div><div class="score">${p.score} 分</div><div class="online">${p.connected?'🟢 在線':'🔴 離線'}</div>`;box.appendChild(row)})}
setInterval(()=>{if(!room)return;let left=null;if(room.status==='playing'&&room.endsAt)left=room.endsAt-Date.now();else if(room.status==='scheduled'&&room.startAt)left=room.startAt-Date.now();$('timeText').textContent=left==null?'--:--':fmt(left)},250);
