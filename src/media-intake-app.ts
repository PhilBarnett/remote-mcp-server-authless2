import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const MEDIA_INTAKE_URI = "ui://blindmotion/media-intake-v3.html";

const MEDIA_INTAKE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Blindmotion Media Intake</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
body{margin:0;padding:16px;background:transparent;color:CanvasText}
.wrap{max-width:760px;margin:0 auto}.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;padding:16px;background:Canvas}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 12px;line-height:1.45}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.filebtn{display:inline-block;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:ButtonFace;color:ButtonText;border-radius:9px;padding:9px 12px;font-weight:600;cursor:pointer}
.filebtn input{display:none}.status{font-size:13px;margin:10px 0;white-space:pre-wrap;line-height:1.45}
.item{display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px 0;border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent)}
.item:first-child{border-top:0}.name{font-size:12px;overflow-wrap:anywhere}.state{font-size:12px;opacity:.78}
.ok{font-weight:700;opacity:1}.err{font-weight:700;opacity:1}small{opacity:.72;display:block;margin-top:12px}
</style>
</head>
<body>
<div class="wrap"><div class="card">
<h1>Blindmotion Media Intake</h1>
<p>Choose one ZIP from your computer. Media Intake extracts MP4/MOV files locally in the browser, then streams each video to Meta in exact resumable-upload chunks. No ChatGPT file-export step is used.</p>
<div class="actions">
<label class="filebtn">Choose ZIP<input id="zipInput" type="file" accept=".zip,application/zip"></label>
</div>
<div id="status" class="status">Ready.</div>
<div id="items"></div>
<small>Limits: 20 videos, 80 MB per video. This app cannot create or activate ads or campaigns.</small>
</div></div>
<script>
(() => {
  const openai = window.openai;
  const status = document.getElementById("status");
  const items = document.getElementById("items");
  const zipInput = document.getElementById("zipInput");

  function setStatus(text){
    status.textContent=text;
    if(openai?.setWidgetState){
      openai.setWidgetState({modelContent:"Blindmotion Media Intake status: "+text,privateContent:{status:text}});
    }
  }
  function addItem(name){
    const row=document.createElement("div"); row.className="item";
    const n=document.createElement("div"); n.className="name"; n.textContent=name;
    const s=document.createElement("div"); s.className="state"; s.textContent="Queued";
    row.append(n,s); items.append(row); return s;
  }
  function parseTool(result){
    const blocks=Array.isArray(result?.content)?result.content:[];
    const t=blocks.find(x=>x&&x.type==="text")?.text;
    if(!t) return result?.structuredContent||result||{};
    try{return JSON.parse(t)}catch{return {message:t}}
  }
  function findEocd(bytes){
    const min=Math.max(0,bytes.length-65557);
    for(let i=bytes.length-22;i>=min;i--){
      if(bytes[i]===0x50&&bytes[i+1]===0x4b&&bytes[i+2]===0x05&&bytes[i+3]===0x06) return i;
    }
    throw new Error("ZIP end-of-central-directory record not found.");
  }
  function u16(v,o){return v.getUint16(o,true)}
  function u32(v,o){return v.getUint32(o,true)}
  function parseZip(buffer){
    const bytes=new Uint8Array(buffer), view=new DataView(buffer);
    const eocd=findEocd(bytes);
    const count=u16(view,eocd+10), cdOffset=u32(view,eocd+16);
    const out=[]; let p=cdOffset; const dec=new TextDecoder();
    for(let i=0;i<count;i++){
      if(u32(view,p)!==0x02014b50) throw new Error("Invalid ZIP central directory.");
      const method=u16(view,p+10), compSize=u32(view,p+20), size=u32(view,p+24);
      const nameLen=u16(view,p+28), extraLen=u16(view,p+30), commentLen=u16(view,p+32);
      const localOffset=u32(view,p+42);
      const name=dec.decode(bytes.slice(p+46,p+46+nameLen));
      if(/[.](mp4|mov)$/i.test(name)&&!/[\/]$/.test(name)){
        out.push({name,method,compSize,size,localOffset});
      }
      p+=46+nameLen+extraLen+commentLen;
    }
    return {bytes,view,entries:out};
  }
  async function extractEntry(zip,entry){
    const v=zip.view,b=zip.bytes,p=entry.localOffset;
    if(u32(v,p)!==0x04034b50) throw new Error("Invalid local ZIP header for "+entry.name);
    const nameLen=u16(v,p+26), extraLen=u16(v,p+28);
    const start=p+30+nameLen+extraLen, end=start+entry.compSize;
    const compressed=b.slice(start,end);
    if(entry.method===0) return compressed;
    if(entry.method!==8) throw new Error("Unsupported ZIP compression method "+entry.method+" for "+entry.name);
    if(typeof DecompressionStream!=="function") throw new Error("This browser does not support ZIP deflate decompression.");
    const ds=new DecompressionStream("deflate-raw");
    const ab=await new Response(new Blob([compressed]).stream().pipeThrough(ds)).arrayBuffer();
    const out=new Uint8Array(ab);
    if(out.length!==entry.size) throw new Error("Decompressed size mismatch for "+entry.name);
    return out;
  }
  function baseName(path){return path.split("/").pop()||path}
  function safeFilename(name){
    const ext=/[.]mov$/i.test(name)?".mov":".mp4";
    let stem=name.slice(0,-ext.length).normalize("NFKD").replace(/[^A-Za-z0-9._ -]+/g,"_").replace(/^[_ .-]+|[_ .-]+$/g,"");
    if(!stem) stem="Blindmotion_Video";
    return stem.slice(0,190-ext.length)+ext;
  }
  async function sha256(bytes){
    const dig=await crypto.subtle.digest("SHA-256",bytes);
    return Array.from(new Uint8Array(dig),b=>b.toString(16).padStart(2,"0")).join("");
  }
  function toBase64(bytes){
    let s="", step=0x8000;
    for(let i=0;i<bytes.length;i+=step){
      const chunk=bytes.subarray(i,Math.min(i+step,bytes.length));
      s+=String.fromCharCode(...chunk);
    }
    return btoa(s);
  }
  async function uploadVideo(name,bytes,state,completed){
    if(!openai?.callTool) throw new Error("ChatGPT tool bridge unavailable.");
    if(bytes.length>80000000) throw new Error(name+" exceeds 80 MB.");
    const title=baseName(name).replace(/[.][^.]+$/,"").slice(0,255);
    const filename=safeFilename(baseName(name));
    const mime=/[.]mov$/i.test(filename)?"video/quicktime":"video/mp4";
    state.textContent="Starting";
    let r=parseTool(await openai.callTool("manage_meta_video_upload_session_guarded",{
      action:"start",title,filename,mime_type:mime,file_size:bytes.length,
      confirmation:"CONFIRM UPLOAD META VIDEO BATCH"
    }));
    if(!r?.upload_session_id||!r?.video_id) throw new Error(r?.message||"Start failed for "+name);
    let start=Number(r.start_offset), end=Number(r.end_offset);
    while(end>start){
      const chunk=bytes.subarray(start,end);
      state.textContent="Uploading "+Math.floor((start/bytes.length)*100)+"%";
      const h=await sha256(chunk);
      r=parseTool(await openai.callTool("manage_meta_video_upload_session_guarded",{
        action:"transfer",
        video_id:String(r.video_id),
        upload_session_id:String(r.upload_session_id),
        start_offset:start,end_offset:end,
        chunk_base64:toBase64(chunk),chunk_sha256:h,
        confirmation:"CONFIRM UPLOAD META VIDEO BATCH"
      }));
      if(!Number.isFinite(Number(r?.start_offset))||!Number.isFinite(Number(r?.end_offset))) throw new Error(r?.message||"Transfer failed for "+name);
      start=Number(r.start_offset); end=Number(r.end_offset);
    }
    state.textContent="Finishing";
    const final=parseTool(await openai.callTool("manage_meta_video_upload_session_guarded",{
      action:"finish",
      video_id:String(r.video_id),
      upload_session_id:String(r.upload_session_id),
      title,file_size:bytes.length,final_offset:start,
      confirmation:"CONFIRM UPLOAD META VIDEO BATCH"
    }));
    if(final?.uploaded!==true) throw new Error(final?.message||"Finish failed for "+name);
    state.textContent="Meta "+final.video_id; state.className="state ok";
    completed.push({source_name:name,meta_video_id:String(final.video_id),processing_complete:Boolean(final.processing_complete),file_size:bytes.length});
    if(openai?.setWidgetState){
      openai.setWidgetState({modelContent:"Blindmotion Media Intake uploaded "+completed.length+" video(s): "+JSON.stringify(completed),privateContent:{completed}});
    }
  }
  zipInput.addEventListener("change",async()=>{
    const file=zipInput.files?.[0]; if(!file) return;
    items.innerHTML="";
    const completed=[];
    try{
      setStatus("Reading ZIP locally…");
      const buffer=await file.arrayBuffer();
      const zip=parseZip(buffer);
      if(!zip.entries.length) throw new Error("No MP4/MOV files found in ZIP.");
      if(zip.entries.length>20) throw new Error("ZIP contains more than 20 videos.");
      setStatus("Found "+zip.entries.length+" video(s). Extracting and uploading sequentially…");
      for(let i=0;i<zip.entries.length;i++){
        const e=zip.entries[i], state=addItem(e.name);
        try{
          state.textContent="Extracting";
          const bytes=await extractEntry(zip,e);
          await uploadVideo(e.name,bytes,state,completed);
        }catch(err){
          state.textContent="Error"; state.className="state err";
          throw err;
        }
      }
      setStatus("Complete: "+completed.length+" video(s) uploaded to Meta.");
      if(openai?.setWidgetState){
        openai.setWidgetState({modelContent:"Blindmotion Media Intake complete. Uploaded Meta videos: "+JSON.stringify(completed),privateContent:{completed}});
      }
      if(openai?.sendFollowUpMessage){
        await openai.sendFollowUpMessage({prompt:"Blindmotion Media Intake completed. Continue the paused ZipGrip campaign build using the uploaded Meta videos.",scrollToBottom:true});
      }
    }catch(error){
      setStatus("Error: "+(error?.message||String(error)));
    }finally{
      zipInput.value="";
    }
  });
})();
</script>
</body>
</html>`;

export function registerMediaIntakeApp(server: McpServer) {
	server.registerResource(
		"blindmotion-media-intake",
		MEDIA_INTAKE_URI,
		{},
		async () => ({
			contents: [{
				uri: MEDIA_INTAKE_URI,
				mimeType: "text/html;profile=mcp-app",
				text: MEDIA_INTAKE_HTML,
				_meta: {
					ui: { prefersBorder: true },
					"openai/widgetDescription":
						"Blindmotion Media Intake locally extracts ZIP creative and streams each video through a guarded Meta resumable-upload session.",
				},
			}],
		}),
	);

	server.registerTool(
		"open_blindmotion_media_intake",
		{
			title: "Open Blindmotion Media Intake",
			description:
				"Open Blindmotion Media Intake to choose one local ZIP, extract MP4/MOV files in the browser and stream them to Meta through guarded resumable uploads. This tool does not create or activate ads or campaigns.",
			inputSchema: z.object({}),
			_meta: {
				ui: { resourceUri: MEDIA_INTAKE_URI },
				"openai/toolInvocation/invoking": "Opening Media Intake…",
				"openai/toolInvocation/invoked": "Media Intake ready.",
			},
		},
		async () => ({
			structuredContent: { ready: true, purpose: "blindmotion_media_intake_v3" },
			content: [{ type: "text" as const, text: "Blindmotion Media Intake v3 is ready. Choose the ZIP in the app." }],
		}),
	);
}
