from pathlib import Path

path = Path("src/index.ts")
text = path.read_text(encoding="utf-8")

import_anchor = 'import { z } from "zod";'
import_line = 'import { registerMetaEcommerceToolkit } from "./meta-ecommerce-toolkit";'
if import_line not in text:
    if import_anchor not in text:
        raise SystemExit("zod import anchor not found")
    text = text.replace(import_anchor, import_anchor + "\n" + import_line, 1)

server_anchor = '''\tconst server = new McpServer({
\t\tname: "Blindmotion WooCommerce",
\t\tversion: "2.0.0",
\t});'''
registration = '\tregisterMetaEcommerceToolkit(server);'
if registration not in text:
    if server_anchor not in text:
        raise SystemExit("createServer anchor not found")
    text = text.replace(server_anchor, server_anchor + "\n\n" + registration, 1)

path.write_text(text, encoding="utf-8")
