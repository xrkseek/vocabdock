/**
 * Smoke: Youdao direct + rich fields for glaring.
 * Run: npm run smoke
 */
import fs from "node:fs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;

  const res = await fetch("https://dict.youdao.com/jsonapi?q=glaring");
  assert(res.ok, `status ${res.status}`);
  const j = await res.json();

  const meaning = j.ec?.word?.[0]?.trs?.[0]?.tr?.[0]?.l?.i?.[0] ?? "";
  assert(/耀眼|瞪视|明显/.test(meaning), `meaning ${meaning}`);

  const forms = j.rel_word?.rels?.length;
  assert(forms > 0, "rel_word present");

  const phrase = j.phrs?.phrs?.[0]?.phr?.headword?.l?.i;
  assert(phrase, "phrase present");

  const syn = j.syno?.synos?.[0]?.syno?.ws?.length;
  assert(syn > 0, "synonyms present");

  const etym = j.etym?.etyms?.zh?.[0]?.value;
  assert(etym, "etymology present");

  const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert(app.includes("pillTopPx") && app.includes("fanTopPx"), "Noty Y geometry");
  assert(app.includes("shrinkDelayMs"), "delayed shrink");
  assert(app.includes("派生"), "forms UI");

  const rust = fs.readFileSync(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  assert(rust.includes("youdao_forms"), "rust forms");
  assert(rust.includes("no_proxy"), "no proxy");

  console.log("SMOKE_OK");
  console.log("  meaning:", meaning);
  console.log("  stem:", j.rel_word?.stem);
  console.log("  phrase:", phrase);
  console.log("  etym:", etym.slice(0, 40));
}

main().catch((e) => {
  console.error("SMOKE_FAIL", e);
  process.exit(1);
});
