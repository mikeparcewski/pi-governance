import { readFileSync } from 'node:fs';
const file = process.argv[2];
const recs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
for (const r of recs) {
  const m = r.msg;
  let s;
  if (m.method === 'session/update') {
    const u = m.params.update;
    s = 'update ' + u.sessionUpdate + ' id=' + (u.toolCallId ?? '') + ' status=' + (u.status ?? '') + ' title=' + JSON.stringify(String(u.title ?? '').slice(0, 70));
  } else if (m.method === 'session/request_permission') {
    s = 'REQ_PERMISSION rpcid=' + m.id + ' uiTc=' + m.params.toolCall.toolCallId + ' title=' + JSON.stringify(String(m.params.toolCall.title).slice(0, 160));
  } else if (m.method) {
    s = m.method + ' ' + JSON.stringify(m.params ?? {}).slice(0, 100);
  } else if (m.result !== undefined) {
    s = 'RESULT rpcid=' + m.id + ' ' + JSON.stringify(m.result).slice(0, 140);
  } else {
    s = JSON.stringify(m).slice(0, 140);
  }
  console.log(String(r.seq).padStart(3), r.ts.slice(11, 23), r.direction.padEnd(11), s);
}
