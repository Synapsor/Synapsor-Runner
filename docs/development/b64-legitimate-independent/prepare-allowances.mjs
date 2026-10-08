import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const dir = new URL('.', import.meta.url);
const verdict = JSON.parse(fs.readFileSync(new URL('VERDICT.json', dir)));
const scanPath = '/var/tmp/synapsor-b64-main-owned/evidence/language-guard-lookup-scan.json';
const scanBytes = fs.readFileSync(scanPath);
const scan = JSON.parse(scanBytes);
const sourcePin = '934ad542ac17ed2f99e76fe38484704d6186af70';
const hash = x => createHash('sha256').update(x).digest('hex');
const printer = ts.createPrinter({ removeComments: true });
const rows = verdict.entries.filter(x => x.verdict === 'legitimate');
const accepted = [], rejected = [], located = new Set();
const maps = rows.map(row => ({annotation_id:row.annotation_id,file:row.current_file,reviewed_anchors:row.current_exact_evidence.map(x=>x.line),fingerprints:[]}));
const rowMap = new Map(maps.map(x=>[x.annotation_id,x]));
const records = new Map();
for (const row of rows) {
 if (!records.has(row.current_file)) records.set(row.current_file,[]);
 records.get(row.current_file).push(row);
}
const ownerName = node => node.name?.getText() ?? (ts.isVariableStatement(node) ? node.declarationList.declarations.map(x=>x.name.getText()).join(',') : ts.SyntaxKind[node.kind]);
for (const [file,fileRows] of records) {
 const text = execFileSync('git',['show',`${sourcePin}:${file}`],{encoding:'utf8'});
 if (fileRows.some(r=>r.current_file_sha256!==hash(text))) throw Error(`Changed audited source ${file}`);
 const source = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 const rendered=new WeakMap(), digests=new WeakMap();
 const print = node=>{if(!rendered.has(node))rendered.set(node,printer.printNode(ts.EmitHint.Unspecified,node,source));return rendered.get(node)};
 const digest = node=>{if(!digests.has(node))digests.set(node,hash(print(node)));return digests.get(node)};
 const pool=scan.errors.filter(x=>x.file===file);
 const positionMap = new Map();
 for(const c of pool){const k=`${c.line}:${c.column}`; if(!positionMap.has(k))positionMap.set(k,[]);positionMap.get(k).push(c);}
 const seen = new Set();
 function visit(node,outer) {
  if (!outer&&!ts.isSourceFile(node)&&node.parent&&ts.isSourceFile(node.parent))outer=node;
  const loc=source.getLineAndCharacterOfPosition(node.getStart(source));
  const candidates=positionMap.get(`${loc.line+1}:${loc.character+1}`)??[];
  if(candidates.length) {
   const expression=print(node), expressionDigest=digest(node), ownerDigest=digest(outer??node);
   for(const c of candidates){
    if(seen.has(c.fingerprint)||c.expression_digest!==expressionDigest||c.owner_digest!==ownerDigest)continue;
    seen.add(c.fingerprint);
    if(['predicate_consumer','lookup_vocabulary'].includes(c.syntax_kind))continue;
    let anchor=node.getStart(source);
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression))anchor=node.expression.name.getStart(source);
    const anchorLine=source.getLineAndCharacterOfPosition(anchor).line+1;
    const matching=fileRows.filter(r=>r.current_exact_evidence.some(x=>x.line===anchorLine));
    if(!matching.length)continue;
    const categories=[...new Set(matching.map(r=>r.category))];
    const detail={...c,kind:c.syntax_kind,anchor_line:anchorLine,full_expression:expression,owner_name:ownerName(outer??node),annotation_ids:matching.map(x=>x.annotation_id)};
    if(categories.length!==1){rejected.push({...detail,reason:'Overlapping reviewed anchors have different purposes; no automatic purpose selection.'});continue;}
    if(!['regex','dynamic_regex','text_or_membership_operation','literal_comparison','literal_vocabulary','literal_case'].includes(c.syntax_kind)){
     rejected.push({...detail,reason:'Indexed/computed use is not separately approved by this original exact-expression review.'});continue;
    }
    accepted.push({fingerprint:c.fingerprint,file,annotation_id:matching[0].annotation_id,annotation_ids:matching.map(x=>x.annotation_id),category:categories[0],reason:matching.map(x=>x.reason).filter((x,i,a)=>a.indexOf(x)===i).join(' '),review:{reviewer:'R1 /root/early_full_triage',verdict:'accepted',evidence:'docs/development/b64-legitimate-independent/VERDICT.json at a6f16baa; exact-expression map on 934ad542'},source_pin:sourcePin,line:c.line,column:c.column,anchor_line:anchorLine,kind:c.syntax_kind,owner_name:ownerName(outer??node),owner_digest:ownerDigest,expression_digest:expressionDigest,expression,occurrence:c.occurrence});
    for(const r of matching)rowMap.get(r.annotation_id).fingerprints.push(c.fingerprint);
   }
  }
  ts.forEachChild(node,child=>visit(child,outer));
 }
 visit(source,undefined);
}
for(const row of maps)row.status=row.fingerprints.length?'exact_expression_mapped':'no_exact_scanner_candidate_at_reviewed_anchor';
const meta={source_pin:sourcePin,scanner_pin:sourcePin,scan_path:scanPath,scan_sha256:hash(scanBytes),source_audit_pin:'a6f16baa612b715a8c404e46bc869e6673cca291',reviewed_annotations:101,broad_scan_candidates:scan.candidates};
fs.writeFileSync(new URL('ALLOWLIST.json',dir),JSON.stringify({version:1,...meta,entries:accepted},null,2)+'\n');
fs.writeFileSync(new URL('ALLOWLIST-MAPPING.json',dir),JSON.stringify({...meta,entries:maps,rejected,...{counts:{accepted_fingerprints:accepted.length,mapped_annotations:maps.filter(x=>x.fingerprints.length).length,unmapped_annotations:maps.filter(x=>!x.fingerprints.length).length,rejected:rejected.length,other_candidates_not_approved:scan.candidates-accepted.length}}},null,2)+'\n');
console.log(JSON.stringify({accepted:accepted.length,mapped:maps.filter(x=>x.fingerprints.length).length,rejected:rejected.length}));
