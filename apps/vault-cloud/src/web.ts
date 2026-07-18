/**
 * Minimal authenticated vault viewer. Served as a static shell; all data
 * access goes through the token-authenticated /v1 API using a bearer token
 * the visitor pastes once (kept in localStorage). No external assets.
 */
export const WEB_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Apna Vault</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; flex-direction: column; height: 100vh; }
  header { padding: 0.6rem 1rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
           display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 1rem; margin: 0; }
  header input { font: inherit; padding: 0.2rem 0.45rem; }
  main { display: flex; flex: 1; min-height: 0; }
  nav { width: 280px; overflow-y: auto; border-right: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        padding: 0.5rem 0; }
  nav button { display: block; width: 100%; text-align: left; border: 0; background: none;
               font: inherit; padding: 0.25rem 1rem; cursor: pointer; color: inherit;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  nav button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  nav button.active { background: color-mix(in srgb, currentColor 16%, transparent); }
  #content { flex: 1; overflow-y: auto; padding: 1.25rem 2rem; }
  #content img { max-width: 100%; }
  #content pre { overflow-x: auto; padding: 0.75rem; border-radius: 6px;
                 background: color-mix(in srgb, currentColor 8%, transparent); }
  #content code { background: color-mix(in srgb, currentColor 8%, transparent);
                  padding: 0.1rem 0.3rem; border-radius: 4px; }
  #content pre code { background: none; padding: 0; }
  #content blockquote { border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent);
                        margin-left: 0; padding-left: 1rem; }
  #status { font-size: 0.85rem; opacity: 0.75; }
</style>
</head>
<body>
<header>
  <h1>Apna Vault</h1>
  <label>vault <input id="vault" size="10" /></label>
  <label>token <input id="token" type="password" size="18" placeholder="bearer token" /></label>
  <button id="load">Load</button>
  <span id="status"></span>
</header>
<main>
  <nav id="files"></nav>
  <section id="content"><p>Enter the sync token, then Load.</p></section>
</main>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
$("vault").value = localStorage.getItem("apna.vaultId") || "vault";
$("token").value = localStorage.getItem("apna.token") || "";

function esc(text) {
  return text.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function inline(text) {
  return esc(text)
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\\*([^*\\s][^*]*)\\*/g, "$1<em>$2</em>")
    .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" rel="noopener">$1</a>');
}

function renderMarkdown(source) {
  const lines = source.split(/\\r?\\n/);
  const out = [];
  let index = 0;
  // Skip YAML frontmatter but show it as metadata.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      out.push("<pre>" + esc(lines.slice(1, end).join("\\n")) + "</pre>");
      index = end + 1;
    }
  }
  let list = null;
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("\`\`\`")) {
      const buffer = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("\`\`\`")) {
        buffer.push(lines[index]);
        index += 1;
      }
      index += 1;
      closeList();
      out.push("<pre><code>" + esc(buffer.join("\\n")) + "</code></pre>");
      continue;
    }
    const heading = line.match(/^(#{1,6})\\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
    } else if (/^\\s*[-*]\\s+/.test(line)) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(line.replace(/^\\s*[-*]\\s+/, "")) + "</li>");
    } else if (/^\\s*\\d+\\.\\s+/.test(line)) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inline(line.replace(/^\\s*\\d+\\.\\s+/, "")) + "</li>");
    } else if (/^\\s*>\\s?/.test(line)) {
      closeList();
      out.push("<blockquote>" + inline(line.replace(/^\\s*>\\s?/, "")) + "</blockquote>");
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push("<p>" + inline(line) + "</p>");
    }
    index += 1;
  }
  closeList();
  return out.join("\\n");
}

async function api(path) {
  const token = $("token").value.trim();
  const response = await fetch(path, { headers: { authorization: "Bearer " + token } });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response;
}

async function openFile(path, mediaType, button) {
  for (const other of document.querySelectorAll("nav button")) other.classList.remove("active");
  button.classList.add("active");
  const vault = encodeURIComponent($("vault").value.trim());
  const content = $("content");
  try {
    const response = await api("/v1/vaults/" + vault + "/files/" + path.split("/").map(encodeURIComponent).join("/"));
    if (mediaType.startsWith("image/")) {
      const url = URL.createObjectURL(await response.blob());
      content.innerHTML = "";
      const img = document.createElement("img");
      img.src = url;
      content.appendChild(img);
    } else if (mediaType === "text/markdown") {
      content.innerHTML = renderMarkdown(await response.text());
    } else {
      content.innerHTML = "<pre>" + esc(await response.text()) + "</pre>";
    }
  } catch (error) {
    content.innerHTML = "<p>Failed to load " + esc(path) + ": " + esc(String(error)) + "</p>";
  }
}

$("load").addEventListener("click", async () => {
  const vault = $("vault").value.trim();
  localStorage.setItem("apna.vaultId", vault);
  localStorage.setItem("apna.token", $("token").value.trim());
  const statusEl = $("status");
  statusEl.textContent = "loading…";
  try {
    const manifest = await (await api("/v1/vaults/" + encodeURIComponent(vault) + "/manifest")).json();
    const nav = $("files");
    nav.innerHTML = "";
    for (const file of manifest.files) {
      const button = document.createElement("button");
      button.textContent = file.path;
      button.addEventListener("click", () => openFile(file.path, file.mediaType, button));
      nav.appendChild(button);
    }
    statusEl.textContent = manifest.files.length + " files · rev " + manifest.revision.slice(0, 13) + " · " + manifest.generatedAt;
  } catch (error) {
    statusEl.textContent = String(error);
  }
});
</script>
</body>
</html>
`;
