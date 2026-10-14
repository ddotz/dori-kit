import { omoProcs, sessionFile } from "./omo-proc.ts";
import { cfg } from "./config.ts";
const CWD=cfg.agent_cwd;
const SF=sessionFile(CWD,(await omoProcs()).find(p=>p.cwd===CWD)?.sessionArg)!;
const sleep=(ms:number)=>Bun.sleep(ms);
const log=(m:string)=>console.log(new Date().toISOString(), m);
const j=JSON.parse(await Bun.$`herdr pane list`.text()); const id=j.result.panes.find((x:any)=>x.cwd===CWD||x.foreground_cwd===CWD).pane_id;
async function send(t:string){ await Bun.$`herdr pane send-text ${id} ${t}`.quiet(); await sleep(600); await Bun.$`herdr pane send-keys ${id} Enter`.quiet(); }
const running=async()=>(await omoProcs()).some(p=>p.cwd===CWD);
async function waitFor(c:()=>Promise<boolean>,ms:number,step=2000){const e=Date.now()+ms;while(Date.now()<e){if(await c())return true;await sleep(step);}return false;}
log("pane "+id+" file "+SF);
await waitFor(async()=>Date.now()-(await Bun.file(SF).stat()).mtimeMs>20e3, 10*60e3);
await send("/quit");
if(!(await waitFor(async()=>!(await running()),60e3))){ log("quit failed"); process.exit(1); }
await sleep(1500);
await send("PI_CACHE_RETENTION=long omo --model anthropic/claude-opus-5-5 --thinking medium");
if(!(await waitFor(running,60e3))){ log("start failed"); process.exit(1); }
await sleep(25e3);
await send("저번 세션처럼 찾아서 "+cfg.identity.name+" 모드 해줘. 이전 세션 파일은 "+SF+" (필요하면 끝부분만 참고). 방금 사용자 요청으로 새 세션으로 갈아탄 거라 켜지면 #💬┃대화("+cfg.discord.channels.chat+")에 다시 왔다고 한 줄 보내고, #📋┃작업로그에도 한 줄 남겨.");
log("done");
