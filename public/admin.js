const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);
let room = null;
let adminToken = sessionStorage.getItem('whackAdminToken') || '';

function statusLabel(s){return ({waiting:'等待中',scheduled:'已預約',countdown:'倒數中',playing:'遊戲中',finished:'已結束'})[s]||s}
function fmt(ms){if(ms==null||ms<0)return '00:00';const s=Math.ceil(ms/1000),m=Math.floor(s/60),r=s%60;return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`}
function currentRoomId(){return $('roomId').value.trim()||'001'}
function joinAdmin(){socket.emit('admin:join',{roomId:currentRoomId(),token:adminToken})}
function showLogin(message=''){
  $('adminApp').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('loginMsg').textContent=message;
  $('adminPassword').value='';
  setTimeout(()=>$('adminPassword').focus(),50);
}
function showAdmin(){
  $('loginView').classList.add('hidden');
  $('adminApp').classList.remove('hidden');
  if(!socket.connected) socket.connect(); else joinAdmin();
}

$('loginForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const password=$('adminPassword').value;
  $('loginMsg').textContent='登入中...';
  try{
    const res=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
    const data=await res.json();
    if(!res.ok) throw new Error(data.message||'登入失敗');
    adminToken=data.token;
    sessionStorage.setItem('whackAdminToken',adminToken);
    $('loginMsg').textContent='';
    showAdmin();
  }catch(err){$('loginMsg').textContent=err.message||'登入失敗'}
});

$('logoutBtn').addEventListener('click', async()=>{
  try{await fetch('/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:adminToken})})}catch{}
  adminToken='';room=null;sessionStorage.removeItem('whackAdminToken');socket.disconnect();showLogin('已登出');
});

socket.on('connect',()=>{$('conn').textContent='🟢 已連線';joinAdmin()});
socket.on('disconnect',()=>{if(!$('adminApp').classList.contains('hidden'))$('conn').textContent='🔴 已斷線'});
socket.on('admin:authError',msg=>{adminToken='';sessionStorage.removeItem('whackAdminToken');socket.disconnect();showLogin(msg||'請重新登入')});
socket.on('room:update',r=>{room=r;render()});
socket.on('game:countdown',n=>{if(room){room.countdown=n;render()}});

function render(){
  if(!room)return;
  $('sessionText').textContent=room.sessionNo;
  $('statusText').textContent=statusLabel(room.status);
  $('onlineText').textContent=room.players.filter(p=>p.connected).length;
  $('noteText').textContent=room.note?`📝 ${room.note}`:'';
  $('countdownText').textContent=room.status==='countdown'?`開賽倒數：${room.countdown}`:'';
  $('shareUrl').textContent=`玩家網址：${location.origin}/play.html?room=${encodeURIComponent(room.id)}`;
  const box=$('ranking');box.innerHTML='';
  if(!room.players.length){box.innerHTML='<p class="muted">尚無玩家</p>'}
  room.players.forEach(p=>{
    const row=document.createElement('div');row.className='rank-row';
    row.innerHTML=`<div class="rank">${p.rank<=3?['🥇','🥈','🥉'][p.rank-1]:p.rank}</div><div>${escapeHtml(p.name)}</div><div class="score">${p.score} 分</div><div class="online">${p.connected?'🟢 在線':'🔴 離線'}</div>`;
    box.appendChild(row);
  });
}
function escapeHtml(s){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function sendSettings(){
  const dt=$('startAt').value;
  socket.emit('admin:settings',{
    roomId:currentRoomId(),sessionNo:currentRoomId(),difficulty:$('difficulty').value,
    durationSec:Number($('durationSec').value),moleIntervalMs:Number($('moleIntervalMs').value),countdownSec:Number($('countdownSec').value),
    startAt:dt?new Date(dt).getTime():null,note:$('note').value
  });
}
$('saveBtn').addEventListener('click',sendSettings);
$('startBtn').addEventListener('click',()=>{sendSettings();setTimeout(()=>socket.emit('admin:startNow',{roomId:currentRoomId()}),100)});
$('finishBtn').addEventListener('click',()=>socket.emit('admin:finish',{roomId:currentRoomId()}));
$('resetBtn').addEventListener('click',()=>socket.emit('admin:reset',{roomId:currentRoomId()}));
$('roomId').addEventListener('change',joinAdmin);
$('copyUrlBtn').addEventListener('click',async()=>{const url=`${location.origin}/play.html?room=${encodeURIComponent(currentRoomId())}`;await navigator.clipboard.writeText(url);alert('已複製玩家網址')});
$('copyRankBtn').addEventListener('click',async()=>{
  if(!room)return;let txt=`🏆 打地鼠排行榜\n場次：${room.sessionNo}\n\n`;
  room.players.forEach(p=>{txt+=`${p.rank<=3?['🥇','🥈','🥉'][p.rank-1]:p.rank+'.'} ${p.name}　${p.score} 分${p.connected?'':'（離線）'}\n`});
  txt+=`\n遊戲人數：${room.players.length} 人`;
  await navigator.clipboard.writeText(txt);alert('已複製排行榜');
});

setInterval(()=>{if(!room)return;let left=null;if(room.status==='playing'&&room.endsAt)left=room.endsAt-Date.now();else if(room.status==='scheduled'&&room.startAt)left=room.startAt-Date.now();$('timeText').textContent=left==null?'--:--':fmt(left)},250);

if(adminToken) showAdmin(); else showLogin();
