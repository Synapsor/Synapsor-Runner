"""Render one complete alternate-screen redraw, without joining log pages."""
import re,sys,json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
log=Path(sys.argv[1]);out=Path(sys.argv[2]);text=log.read_bytes().decode()
start=text.index('\x1b[H\x1b[2J',text.index('Checking saved record links') if 'Checking saved record links' in text else 0)
text=text[start:];end=text.index('Up/Down Navigate   Enter Select   Esc Back')+len('Up/Down Navigate   Enter Select   Esc Back');text=text[:end]
assert 'SETUP NEEDS ATTENTION' in text
lines=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',text).replace('\r','').split('\n');assert len(lines)<=30 and max(map(len,lines))<=100
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',16)
im=Image.new('RGB',(100*10+24,30*22+24),'#101318');d=ImageDraw.Draw(im)
for i,line in enumerate(lines):d.text((12,12+i*22),line,font=font,fill='#e4e8ed')
im.save(out);out.with_suffix('.json').write_text(json.dumps({'source':str(log),'columns':100,'rows':30,'frame_lines':len(lines),'longest_line':max(map(len,lines)),'method':'Complete emitted alternate-screen redraw, no concatenation of pages','lines':lines},indent=2))
