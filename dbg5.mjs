import { tempHome } from './test/helpers.mjs'
const tmp=await tempHome(); const store=tmp.store.createStore(tmp.openDb())
const p=store.createNode({type:'project',name:'P'})
const r=store.createNode({parentId:p.id,type:'requirement',name:'R'})
store.upsertDocument(r.id,'需求内容','需求正文'); store.upsertDocument(r.id,'概要设计','设计正文')
const tc=store.upsertTestCase(r.id,{name:'回归用例',prompt:'跑单测'})
const rep=store.createTestReport(r.id,{caseId:tc.id,status:'running',kind:'regression'}); store.finishTestReport(rep.id,{status:'pass',summary:'全绿'})
const g=store.buildDeliveryGate(r.id)
console.log('decision=',g.decision,'sources=',g.sources.map(s=>`${s.key}=${s.status}`).join(' '))
