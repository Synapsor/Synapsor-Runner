"""Record the real terminal using script(1); argv quoting never contains secrets."""
import os,sys,shlex
from pathlib import Path
log=Path(sys.argv[1]);assert not log.exists();os.umask(0o077)
os.execvp('script',['script','--quiet','--flush','--return','--log-timing',str(log)+'.timing','--logging-format','advanced','--command',shlex.join(sys.argv[2:]),str(log)])
