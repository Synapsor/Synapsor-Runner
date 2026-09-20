from pathlib import Path
import sys,re,json
r=Path('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919');case,name=sys.argv[1:];d=r/'public'/case
p=max(d.glob('terminal-*.log'),key=lambda x:int(x.stem.split('-')[-1]));raw=p.read_text();frames=re.split(r'\x1b\[\d+F',raw);frame=frames[-1];plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',frame).replace('\r','');out=d/(name+'.txt');out.write_text(plain);(d/(name+'.raw')).write_text(frame);print(json.dumps({'frame':str(out),'terminal_log':str(p),'dimensions':[100,30]}))
