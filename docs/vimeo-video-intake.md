# Vimeo website-video intake

The Blindmotion MCP can upload approved MP4/MOV files directly to the Vimeo account
used by the website. The upload path is available in the existing Media Intake app;
choose **Vimeo — website video** before selecting files.

## One-time Vimeo connection

1. In Vimeo, create or open the Blindmotion API app.
2. Generate an authenticated personal access token with `private`, `upload`, and
   `edit` scopes. Vimeo's upload guide requires `upload` and `edit`; `private` lets
   the MCP verify videos that are not public.
3. Save the token as the encrypted Cloudflare Worker secret
   `VIMEO_ACCESS_TOKEN`. Never put it in source, GitHub variables, task notes, or
   chat.
4. Optional: set `VIMEO_FOLDER_URI` as a normal Worker variable using the exact
   Vimeo folder URI `/users/{user_id}/projects/{project_id}`.
5. Refresh the Blindmotion MCP connection, then call `manage_vimeo_video` with
   `action: "connection"`. It must report `configured: true` and the intended
   Vimeo account before uploading.

Paid Vimeo accounts normally have API upload access. Vimeo Free accounts need
their API application approved for upload access first.

Official references:

- <https://developer.vimeo.com/api/upload/videos>
- <https://help.vimeo.com/hc/en-us/articles/12427789081745-How-to-generate-a-personal-access-token>
- <https://help.vimeo.com/hc/en-us/articles/12427803706001-How-to-request-API-upload-access>

## Safety and behaviour

- `manage_vimeo_video` consolidates connection status, exact-video inspection and
  upload permits into one MCP tool.
- Upload permits are single-use, expire after 10 minutes and are locked to the
  filename, MIME type and exact byte count.
- The browser streams bytes through the fixed Worker endpoint. The Vimeo token is
  never sent to the browser or returned by the MCP.
- Each new video is created with `privacy.view=disable` (Vimeo's embed-only
  behaviour), `privacy.embed=public`, and downloads disabled. The result can be
  embedded on the product website but is not exposed as a normal Vimeo page.
- The Worker uses Vimeo's TUS upload flow, checks upload length and offset with a
  HEAD request, then reads the video back by ID and verifies the exact title.
- An exact existing title is treated as an idempotent match. Multiple exact title
  matches are refused.
- No tool can delete a Vimeo video, replace its source file, or make it public on
  Vimeo. If a Vimeo placeholder is created but the byte upload fails, the result
  reports its video ID for manual inspection rather than silently deleting it.

The current browser limit remains 20 videos per batch and 80 MB per video. Larger
files should be compressed or uploaded through Vimeo's own interface until a
chunked browser-to-Vimeo relay is separately reviewed.

## Verification

Run:

```bash
npm run test:vimeo
npm run type-check
npm run audit:mcp-tools -- --max 102
```

The Vimeo tests cover missing configuration, account inspection, token redaction,
exact-title idempotency, permit consumption, MIME/size guards, TUS transfer,
offset verification, read-back verification, replay refusal and partial-failure
reporting.
