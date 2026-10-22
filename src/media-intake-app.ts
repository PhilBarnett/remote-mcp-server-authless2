import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const MEDIA_INTAKE_URI = "ui://blindmotion/media-intake-v1.html";

const MEDIA_INTAKE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Blindmotion Media Intake</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
body{margin:0;padding:16px;background:transparent;color:CanvasText}
.wrap{max-width:760px;margin:0 auto}
.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;padding:16px;background:Canvas}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 12px;line-height:1.4}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
button,.filebtn{appearance:none;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:ButtonFace;color:ButtonText;border-radius:9px;padding:9px 12px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}.filebtn input{display:none}
.status{font-size:13px;margin:10px 0;white-space:pre-wrap}
.item{display:grid;grid-template-columns:1fr auto;gap:8px;padding:9px 0;border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent)}
.item:first-child{border-top:0}.name{font-size:13px;overflow-wrap:anywhere}.state{font-size:12px;opacity:.75}
.ok{font-weight:700}.err{font-weight:700}
small{opacity:.72;display:block;margin-top:10px}
</style>
<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"></script>
</head>
<body>
<div class="wrap"><div class="card">
<h1>Blindmotion Media Intake</h1>
<p>Choose a ZIP of approved creative. Media Intake extracts MP4/MOV files, uploads each as an authorised ChatGPT file, then sends it to the Blindmotion Meta ad account. It does not activate ads or campaigns.</p>
<div class="actions">
<label class="filebtn">Choose ZIP from computer<input id="localZip" type="file" accept=".zip,application/zip"></label>
<button id="libraryBtn" type="button">Choose ZIP from ChatGPT</button>
</div>
<div id="status" class="status">Ready.</div>
<div id="items"></div>
<small>Video uploads use the existing guarded Meta confirmation and whole-file SHA-256 verification.</small>
</div></div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const items = $("items");
  const libraryBtn = $("libraryBtn");
  const localZip = $("localZip");
  const openai = window.openai;

  function setStatus(text){ status.textContent = text; }
  function itemRow(name){
    const row=document.createElement("div"); row.className="item";
    const n=document.createElement("div"); n.className="name"; n.textContent=name;
    const s=document.createElement("div"); s.className="state"; s.textContent="Queued";
    row.append(n,s); items.append(row); return s;
  }
  function bytesToHex(buffer){
    return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2,"0")).join("");
  }
  function safeMetaFilename(name){
    const ext=(name.toLowerCase().endsWith(".mov")?".mov":".mp4");
    let stem=name.replace(/[.][^.]+$/,"").normalize("NFKD").replace(/[^A-Za-z0-9._ -]+/g,"_").replace(/^[_ .-]+|[_ .-]+$/g,"");
    if(!stem) stem="Blindmotion_Video";
    return (stem.slice(0,190-ext.length)+ext);
  }
  function titleFor(name){ return name.replace(/[.][^.]+$/,"").slice(0,250); }
  function parseToolJson(result){
    const blocks=Array.isArray(result?.content)?result.content:[];
    const text=blocks.find(x=>x && x.type==="text")?.text;
    if(!text) return result?.structuredContent || result || {};
    try{return JSON.parse(text)}catch{return {message:text}}
  }
  async function uploadVideo(name, chunks, totalBytes, stateEl, completed){
    try{
      stateEl.textContent="Hashing";
      const joined=new Uint8Array(totalBytes); let off=0;
      for(const chunk of chunks){ joined.set(chunk,off); off+=chunk.length; }
      const hash=bytesToHex(await crypto.subtle.digest("SHA-256", joined));
      const mime=name.toLowerCase().endsWith(".mov")?"video/quicktime":"video/mp4";
      const file=new File([joined], name, {type:mime});
      stateEl.textContent="Authorising";
      if(!openai?.uploadFile || !openai?.getFileDownloadUrl || !openai?.callTool){
        throw new Error("This ChatGPT client does not expose the required file/tool bridge.");
      }
      const uploaded=await openai.uploadFile(file);
      const fileId=uploaded?.fileId || uploaded?.file_id;
      if(!fileId) throw new Error("ChatGPT did not return a file ID.");
      const dl=await openai.getFileDownloadUrl({fileId});
      const downloadUrl=dl?.downloadUrl || dl?.download_url;
      if(!downloadUrl) throw new Error("ChatGPT did not return a temporary download URL.");
      stateEl.textContent="Uploading to Meta";
      const toolResult=await openai.callTool("upload_meta_ad_video_from_host_file_guarded",{
        title:titleFor(name),
        filename:safeMetaFilename(name),
        mime_type:mime,
        file_size:joined.byteLength,
        expected_sha256:hash,
        source_file:{
          download_url:downloadUrl,
          file_id:fileId,
          mime_type:mime,
          file_name:name
        },
        confirmation:"CONFIRM UPLOAD META VIDEO BATCH"
      });
      const parsed=parseToolJson(toolResult);
      if(parsed?.uploaded !== true || !parsed?.video_id){
        throw new Error(parsed?.message || parsed?.error || "Meta upload did not return a video ID.");
      }
      stateEl.textContent="Meta video "+parsed.video_id;
      stateEl.className="state ok";
      completed.push({
        source_name:name,
        chatgpt_file_id:fileId,
        meta_video_id:String(parsed.video_id),
        sha256:hash,
        file_size:joined.byteLength,
        processing_complete:Boolean(parsed.processing_complete)
      });
      if(openai?.setWidgetState){
        openai.setWidgetState({
          modelContent:"Blindmotion Media Intake uploaded "+completed.length+" Meta video(s): "+JSON.stringify(completed),
          privateContent:{completed}
        });
      }
    }catch(error){
      stateEl.textContent="Error";
      stateEl.className="state err";
      throw new Error(name+": "+(error?.message || String(error)));
    }
  }

  async function ingestStream(stream, label){
    if(!window.fflate?.Unzip) throw new Error("ZIP library failed to load.");
    items.innerHTML="";
    setStatus("Reading "+label+"…");
    const completed=[];
    let uploadQueue=Promise.resolve();
    let mediaCount=0;
    const unzip=new fflate.Unzip((entry)=>{
      const name=entry.name || "unnamed";
      const isMedia=/[.](mp4|mov)$/i.test(name) && !/[/]$/.test(name);
      let chunks=[]; let total=0; let stateEl=null;
      if(isMedia){ mediaCount++; stateEl=itemRow(name); }
      entry.ondata=(err,chunk,final)=>{
        if(err){
          if(stateEl){ stateEl.textContent="ZIP error"; stateEl.className="state err"; }
          return;
        }
        if(isMedia && chunk){ chunks.push(chunk); total+=chunk.length; }
        if(final && isMedia){
          const localChunks=chunks; const localTotal=total; chunks=[];
          uploadQueue=uploadQueue.then(()=>uploadVideo(name,localChunks,localTotal,stateEl,completed));
        }
      };
      entry.start();
    });
    if(fflate.UnzipInflate) unzip.register(fflate.UnzipInflate);
    const reader=stream.getReader();
    while(true){
      const {value,done}=await reader.read();
      if(done){ unzip.push(new Uint8Array(0),true); break; }
      unzip.push(value,false);
    }
    if(!mediaCount) throw new Error("No MP4 or MOV files were found in the ZIP.");
    setStatus("Found "+mediaCount+" video(s). Uploading sequentially…");
    await uploadQueue;
    setStatus("Complete: "+completed.length+" video(s) uploaded to Meta. Return to chat and ChatGPT can continue the paused campaign build.");
    if(openai?.setWidgetState){
      openai.setWidgetState({
        modelContent:"Blindmotion Media Intake complete. Uploaded Meta videos: "+JSON.stringify(completed),
        privateContent:{completed}
      });
    }
  }

  localZip.addEventListener("change", async()=>{
    const file=localZip.files?.[0]; if(!file) return;
    try{ await ingestStream(file.stream(),file.name); }
    catch(e){ setStatus("Error: "+(e?.message||String(e))); }
    finally{ localZip.value=""; }
  });

  libraryBtn.addEventListener("click", async()=>{
    try{
      if(!openai?.selectFiles || !openai?.getFileDownloadUrl) throw new Error("ChatGPT file picker is unavailable in this client.");
      const chosen=await openai.selectFiles();
      const zip=(chosen||[]).find(f=>/[.]zip$/i.test(f.fileName||f.file_name||""));
      if(!zip) throw new Error("Select a ZIP file.");
      const fileId=zip.fileId||zip.file_id;
      const dl=await openai.getFileDownloadUrl({fileId});
      const url=dl?.downloadUrl||dl?.download_url;
      if(!url) throw new Error("Could not obtain a download URL for the ZIP.");
      const response=await fetch(url);
      if(!response.ok||!response.body) throw new Error("Could not read the selected ZIP.");
      await ingestStream(response.body,zip.fileName||zip.file_name||"selected ZIP");
    }catch(e){ setStatus("Error: "+(e?.message||String(e))); }
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
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: ["https://oaiusercontent.com", "https://*.oaiusercontent.com"],
              resourceDomains: ["https://cdn.jsdelivr.net"]
            }
          }
        }
      }]
    })
  );

  server.registerTool(
    "open_blindmotion_media_intake",
    {
      title: "Open Blindmotion Media Intake",
      description: "Open the Blindmotion Media Intake app to process a ZIP of approved MP4/MOV creative, authorise each extracted video with ChatGPT, and upload the videos to the configured Meta ad account. This tool does not activate ads or campaigns.",
      inputSchema: z.object({}),
      _meta: {
        ui: { resourceUri: MEDIA_INTAKE_URI },
        "openai/toolInvocation/invoking": "Opening Media Intake…",
        "openai/toolInvocation/invoked": "Media Intake ready."
      }
    },
    async () => ({
      structuredContent: { ready: true, purpose: "blindmotion_media_intake" },
      content: [{ type: "text" as const, text: "Blindmotion Media Intake is ready. Choose a ZIP in the app." }]
    })
  );
}
