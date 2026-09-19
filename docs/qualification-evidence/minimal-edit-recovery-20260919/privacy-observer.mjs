// Test instrumentation only. Schema literals are not a blanket row-value exemption.
// Exact approved structural fragments are masked; arbitrary row-shaped content
// containing the same enum or a synthetic private sentinel is still refused.
export function approvedFragments(value, ambiguousLiterals) {
  const fragments = new Set();
  function walk(node, key) {
    if (!node || typeof node !== 'object') return;
    for (const [k,v] of Object.entries(node)) {
      if (typeof v === 'string' && v.length > 16 && ambiguousLiterals.some(word=>v.includes(word))) {
        // Full approved policy/constraint prose, never individual scalar values.
        if (['when','then','scenario','result','human_review','definition','description'].includes(k)) fragments.add(v);
      }
      if (['enum','values'].includes(k) && Array.isArray(v) && v.some(x=>ambiguousLiterals.includes(x))) fragments.add(JSON.stringify({[k]:v}).slice(1,-1));
      if (k === 'set' && v && typeof v === 'object') {
        for (const literal of Object.values(v)) if(literal?.kind==='literal' && ambiguousLiterals.includes(literal.value)) fragments.add(JSON.stringify(literal));
      }
      walk(v,k);
    }
  }
  walk(value);
  return [...fragments].sort((a,b)=>b.length-a.length);
}
export function assertPrivateInput(body,{private_values,ambiguous_literals,fragments}) {
  const texts=[];
  function walk(v) {if(typeof v==='string')texts.push(v);else if(v&&typeof v==='object')for(const x of Object.values(v))walk(x);}
  let parsed;try{parsed=JSON.parse(String(body));}catch{parsed=String(body);}walk(parsed);
  for(let text of texts) {
    for(const secret of private_values) if(text.includes(secret))throw new Error('QUALIFICATION_PRIVATE_INPUT_REFUSED');
    for(const fragment of fragments) text=text.split(fragment).join('[APPROVED_METADATA]');
    if(ambiguous_literals.some(word=>text.includes(word)))throw new Error('QUALIFICATION_UNREVIEWED_LITERAL_REFUSED');
  }
}
