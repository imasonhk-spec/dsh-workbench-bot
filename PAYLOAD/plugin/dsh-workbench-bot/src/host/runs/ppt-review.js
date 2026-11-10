// Shared with the native PPT package; ordinary approval never clears unresolved requirements.
function explicitReplacement(unit,newer) {
  if(unit.user_order==null) return false;
  if(/[?？]/.test(newer.quote)) return false;
  const old=unit.quote.replace(/[。！？]+$/,'');
  const clauses=newer.quote.replace(/[。！]+$/,'').split(/[；;]/).map(s=>s.trim().replace(/^(?:新明确要求[：:]\s*)?(?:本版)?/,''));
  if(!clauses.every(s=>/^(?:(?:撤销|取消|替代)原要求|保留|恢复|允许出现|应包含)(?:“.+”|".+")$/.test(s))) return false;
  if(clauses.some(s=>['撤销原要求','取消原要求','替代原要求'].some(verb=>s===verb+'“'+old+'”'||s===verb+'"'+old+'"'))) return true;
  const deleted=[...unit.quote.matchAll(/[“"]([^”"]+)[”"]/g)].filter(m=>{
    const prefix=unit.quote.slice(0,m.index),remove=[...prefix.matchAll(/删除|去掉|移除|不得含|不得出现/g)].at(-1),keep=[...prefix.matchAll(/保留|允许|应包含/g)].at(-1);
    return remove&&remove.index>(keep?.index??-1);
  }).map(m=>m[1]);
  // shortcut: only direct quoted cancellation/retention clauses establish replacement; ambiguous or conditional prose needs a new explicit instruction.
  return deleted.length>0&&deleted.every(target=>clauses.some(s=>['保留','恢复','允许出现','应包含'].some(verb=>s===verb+'“'+target+'”'||s===verb+'"'+target+'"')));
}
export function requirementVerificationIssue(review,submission) {
  if(!submission||submission.version!==review.version||submission.sha256!==review.sha256) return '请逐项核实当前草稿；版本已变化或未提交核实记录';
  if(submission.source_sha256!==review.source_sha256) return '草稿要求来源已变化，请重新逐项核实';
  if(!review.requirements.length) return '缺少可核实的原始要求，不能定稿';
  if(!Array.isArray(submission.checks)||submission.checks.length!==review.requirements.length) return '要求尚未逐项核实：'+review.requirements.map(u=>u.id+' '+u.quote).join('；');
  const seen=new Set(),pages=[...new Set(review.evidenceCatalog.map(e=>e.page).filter(Number.isInteger))];
  for(const check of submission.checks) {
    const unit=review.requirements.find(u=>u.id===check?.id);
    if(!unit||seen.has(check.id)) return '核实编号无效或重复';
    seen.add(check.id);
    if(check.status==='superseded') {
      const newer=review.requirements.find(u=>u.id===check.superseded_by);
      if(!newer||newer.user_order==null||newer.user_order<=(unit.user_order??-1)) return '只能引用明确的新用户要求替代旧要求：'+unit.id;
      if(!explicitReplacement(unit,newer)) return '新要求未明确撤销或替代此原要求，请明确引用原要求后再核实：'+unit.id;
      continue;
    }
    if(check.status!=='verified') return '要求仍待核实或未落实：'+unit.quote;
    if(!Array.isArray(check.evidence_ids)||new Set(check.evidence_ids).size!==check.evidence_ids.length||check.evidence_ids.some(id=>!review.evidenceCatalog.some(e=>e.id===id))) return '核实必须引用当前实际页面，不能引用来源编号';
    if(!check.evidence_ids.length&&(!check.whole_deck||!Array.isArray(check.pages)||!pages.length||pages.some(page=>!check.pages.includes(page))||check.pages.some(page=>!pages.includes(page)))) return '请对照来源及全部实际页面逐项核实：'+unit.id;
    // shortcut: 仅对明确带引号的删除词证明反例；其他语义及同义项仍须逐项人工核实，不用禁词表猜测。
    if(unit.user_order!=null) for(const match of unit.quote.matchAll(/[“"]([^”"]+)[”"]/g)) {
      const prefix=unit.quote.slice(0,match.index),deletions=[...prefix.matchAll(/删除|去掉|移除|不得含|不得出现/g)],retentions=[...prefix.matchAll(/保留|允许|应包含/g)];
      if(deletions.length&&(deletions.at(-1).index>(retentions.at(-1)?.index??-1))&&review.evidenceCatalog.some(e=>e.text.includes(match[1]))) return '明确删除要求尚未落实：'+unit.id+' '+match[1];
    }
  }
}
