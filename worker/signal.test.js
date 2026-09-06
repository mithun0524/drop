// Two fake peers against the local worker: do they discover each other and
// does an SDP relay reach exactly the right peer?
const U = 'ws://localhost:8788/ws';
const open = (name, color) => new Promise((res) => {
  const ws = new WebSocket(U); const got = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); got.push(m); if (m.t==='welcome') { ws.id=m.id; ws.send(JSON.stringify({t:'hello',name,color,kind:'phone'})); res({ws,got}); } };
});
const wait = (ms) => new Promise(r=>setTimeout(r,ms));

const a = await open('Green Finch','green');
await wait(200);
const b = await open('Red Fox','red');
await wait(400);

const aSawJoin = a.got.find(m=>m.t==='join');
const bPeers = b.got.find(m=>m.t==='peers');
console.log('A saw B join:      ', aSawJoin?.peer?.name);
console.log('B saw A in roster: ', bPeers?.peers?.map(p=>p.name));

b.ws.send(JSON.stringify({t:'signal', to:a.ws.id, data:{sdp:{type:'offer',sdp:'v=0 fake'}}}));
await wait(300);
const relayed = a.got.find(m=>m.t==='signal');
console.log('A got relayed SDP: ', relayed?.data?.sdp?.sdp, 'from', relayed?.from === b.ws.id ? 'B ✓' : 'WRONG');

b.ws.close();
await wait(400);
console.log('A saw B leave:     ', !!a.got.find(m=>m.t==='leave'));
a.ws.close();

const ok = aSawJoin?.peer?.name==='Red Fox' && bPeers?.peers?.[0]?.name==='Green Finch'
  && relayed?.data?.sdp?.sdp==='v=0 fake' && relayed.from===b.ws.id
  && !!a.got.find(m=>m.t==='leave');
console.log(ok ? '\nsignaling: all checks passed' : '\nsignaling: FAILED');
process.exit(ok?0:1);
