import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const MEDIA_INTAKE_URI = "ui://blindmotion/media-intake-v2.html";

const MEDIA_INTAKE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Blindmotion Media Intake</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
body{margin:0;padding:16px;background:transparent;color:CanvasText}
.wrap{max-width:720px;margin:0 auto}.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;padding:16px;background:Canvas}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 12px;line-height:1.4}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
button,.filebtn{appearance:none;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:ButtonFace;color:ButtonText;border-radius:9px;padding:9px 12px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}.filebtn input{display:none}.status{font-size:13px;margin:10px 0;white-space:pre-wrap;line-height:1.45}
.result{margin-top:12px;padding-top:10px;border-top:1px solid color-mix(in srgb,CanvasText 12%,transparent);font-size:12px;white-space:pre-wrap}
small{opacity:.72;display:block;margin-top:10px}
</style>
</head>
<body>
<div class="wrap"><div class="card">
<h1>Blindmotion Media Intake</h1>
<p>Select one ZIP of approved creative. The ZIP is authorised once, then the Blindmotion Worker stream-extracts MP4/MOV files and uploads them sequentially to Meta.</p>
<div class="actions">
<label class="filebtn">Choose ZIP from computer<input id="localZip" type="file" accept=".zip,application/zip"></label>
<button id="libraryBtn" type="button">Choose ZIP from ChatGPT</button>
</div>
<div id="status" class="status">Ready.</div>
<div id="result" class="result" hidden></div>
<small>This intake cannot create or activate ads or campaigns. Each extracted video is limited to 80 MB and the ZIP stream to 600 MB.</small>
</div></div>
<script>
(() => {
  const openai = window.openai;
  const status = document.getElementById("status");
  const result = document.getElementById("result");
  const localZip = document.getElementById("localZip");
  const libraryBtn = document.getElementById("libraryBtn");

  function setStatus(text){
    status.textContent=text;
    if(openai?.setWidgetState){
      openai.setWidgetState({
        modelContent:"Blindmotion Media Intake status: "+text,
        privateContent:{status:text}
      });
    }
  }
  function parseToolJson(toolResult){
    const blocks=Array.isArray(toolResult?.content)?toolResult.content:[];
    const block=blocks.find(x=>x && x.type==="text");
    if(block?.text){
      try{return JSON.parse(block.text)}catch{return {message:block.text}}
    }
    return toolResult?.structuredContent || toolResult || {};
  }
  async function sendZip(fileId,fileName,mimeType){
    if(!openai?.getFileDownloadUrl || !openai?.callTool) throw new Error("Required ChatGPT file/tool bridge is unavailable.");
    if(!/[.]zip$/i.test(fileName||"")) throw new Error("Select a ZIP file.");
    setStatus("Authorising "+fileName+"…");
    const dl=await openai.getFileDownloadUrl({fileId});
    const downloadUrl=dl?.downloadUrl || dl?.download_url;
    if(!downloadUrl) throw new Error("ChatGPT did not return a ZIP download URL.");
    setStatus("Uploading videos from "+fileName+" to Meta. Keep this card open until completion…");
    const toolResult=await openai.callTool("upload_meta_ad_videos_from_zip_guarded",{
      zip_file:{
        download_url:downloadUrl,
        file_id:fileId,
        mime_type:mimeType || "application/zip",
        file_name:fileName
      },
      confirmation:"CONFIRM UPLOAD META VIDEO BATCH"
    });
    const parsed=parseToolJson(toolResult);
    if(parsed?.uploaded!==true){
      throw new Error(parsed?.message || parsed?.error || "ZIP batch upload did not complete.");
    }
    const videos=Array.isArray(parsed.videos)?parsed.videos:[];
    result.hidden=false;
    result.textContent=videos.map(v => (v.source_path||"video")+" → Meta "+(v.video_id||"?")).join("\n");
    setStatus("Complete: "+videos.length+" video(s) uploaded to Meta.");
    if(openai?.setWidgetState){
      openai.setWidgetState({
        modelContent:"Blindmotion Media Intake complete. Uploaded Meta videos: "+JSON.stringify(videos),
        privateContent:{videos,zip_file_id:fileId}
      });
    }
    if(openai?.sendFollowUpMessage){
      await openai.sendFollowUpMessage({
        prompt:"Blindmotion Media Intake has completed the ZIP upload. Continue the current paused Meta campaign build using the uploaded Meta video IDs shown in the widget state.",
        scrollToBottom:true
      });
    }
  }

  localZip.addEventListener("change",async()=>{
    const file=localZip.files?.[0]; if(!file) return;
    try{
      if(!openai?.uploadFile) throw new Error("ChatGPT file upload is unavailable in this client.");
      setStatus("Uploading "+file.name+" into ChatGPT…");
      const uploaded=await openai.uploadFile(file);
      const fileId=uploaded?.fileId || uploaded?.file_id;
      if(!fileId) throw new Error("ChatGPT did not return a file ID.");
      await sendZip(fileId,file.name,file.type||"application/zip");
    }catch(error){
      setStatus("Error: "+(error?.message||String(error)));
    }finally{
      localZip.value="";
    }
  });

  libraryBtn.addEventListener("click",async()=>{
    try{
      if(!openai?.selectFiles) throw new Error("ChatGPT file library picker is unavailable in this client.");
      const selected=await openai.selectFiles();
      const zip=(selected||[]).find(f=>/[.]zip$/i.test(f.fileName||f.file_name||""));
      if(!zip) throw new Error("Select a ZIP file.");
      await sendZip(
        zip.fileId||zip.file_id,
        zip.fileName||zip.file_name||"creative.zip",
        zip.mimeType||zip.mime_type||"application/zip"
      );
    }catch(error){
      setStatus("Error: "+(error?.message||String(error)));
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
						"Blindmotion Media Intake authorises one ZIP and streams its MP4/MOV files through the guarded Meta batch uploader.",
				},
			}],
		}),
	);

	server.registerTool(
		"open_blindmotion_media_intake",
		{
			title: "Open Blindmotion Media Intake",
			description:
				"Open the Blindmotion Media Intake app to process a ZIP of approved MP4/MOV creative through the guarded Meta batch uploader. This tool does not activate ads or campaigns.",
			inputSchema: z.object({}),
			_meta: {
				ui: { resourceUri: MEDIA_INTAKE_URI },
				"openai/toolInvocation/invoking": "Opening Media Intake…",
				"openai/toolInvocation/invoked": "Media Intake ready.",
			},
		},
		async () => ({
			structuredContent: { ready: true, purpose: "blindmotion_media_intake" },
			content: [{ type: "text" as const, text: "Blindmotion Media Intake is ready. Choose a ZIP in the app." }],
		}),
	);
}
