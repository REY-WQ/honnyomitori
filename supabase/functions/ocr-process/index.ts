import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// OCR後処理用の正規表現（page.tsxと同じ）
const RE_SENT_END     = /[。！？…」』）]$/;
const RE_CHAPTER_HEAD = /^第[一二三四五六七八九十百千万\d]+[章節部]/;
const RE_SEPARATOR    = /^[\*\-─━=＝]{2,}$/;
const RE_NOBRE_PRE    = /^\d+\s+第[一二三四五六七八九十百千万\d]+[章節部]/;
const RE_NOBRE_SUF    = /第[一二三四五六七八九十百千万\d]+[章節部].*\d+$/;
const RE_PAGE_NUM     = /^\s*\d+\s*$/;

function removePrefixDuplicates(sentences: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].trim();
    if (!s) continue;
    if (RE_SENT_END.test(s)) { result.push(s); continue; }
    if (s.length < 10) { result.push(s); continue; }
    const isBleedThrough = sentences.slice(i + 1, i + 10).some(
      (later) => later.trimStart().startsWith(s)
    );
    if (!isBleedThrough) result.push(s);
  }
  return result;
}

function cleanOcrText(raw: string, isFirstPage: boolean, removeBleedThrough: boolean): string {
  const lines = raw.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (RE_PAGE_NUM.test(t)) return false;
    if (RE_NOBRE_PRE.test(t)) return false;
    if (RE_NOBRE_SUF.test(t)) return false;
    if (!isFirstPage && RE_CHAPTER_HEAD.test(t)) return false;
    return true;
  });

  const out: string[] = [];
  let buffer = "";
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    buffer = buffer ? buffer + t : t;
    const keep = RE_SENT_END.test(t) || RE_CHAPTER_HEAD.test(t) || RE_SEPARATOR.test(t);
    if (keep || i === lines.length - 1) {
      out.push(buffer);
      buffer = "";
    }
  }
  if (buffer) out.push(buffer);

  const cleaned = removeBleedThrough ? removePrefixDuplicates(out) : out;
  return cleaned.join("\n").trim();
}

Deno.serve(async (req) => {
  try {
    const { pageId, bookId, isFirstPage, removeBleedThrough } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Storageから画像を取得
    const { data: imageData, error: storageError } = await supabase.storage
      .from("ocr-images")
      .download(`${bookId}/${pageId}`);

    if (storageError || !imageData) {
      await supabase.from("pages").update({ status: "error" }).eq("id", pageId);
      return new Response("Storage error", { status: 500 });
    }

    // base64に変換
    const arrayBuffer = await imageData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    // Google Vision API呼び出し
    const apiKey = Deno.env.get("GOOGLE_VISION_API_KEY")!;
    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ image: { content: base64 }, features: [{ type: "TEXT_DETECTION" }] }],
        }),
        signal: AbortSignal.timeout(25000),
      }
    );

    if (!visionRes.ok) {
      await supabase.from("pages").update({ status: "error" }).eq("id", pageId);
      return new Response("Vision API error", { status: 500 });
    }

    const visionData = await visionRes.json();
    const rawText: string = visionData.responses?.[0]?.fullTextAnnotation?.text ?? "";

    if (rawText) {
      const text = cleanOcrText(rawText, isFirstPage ?? false, removeBleedThrough ?? true);
      await supabase.from("pages").update({
        text,
        status: "done",
        processed_at: new Date().toISOString(),
      }).eq("id", pageId);
      // 成功したら画像を削除
      await supabase.storage.from("ocr-images").remove([`${bookId}/${pageId}`]);
    } else {
      // テキストなし→エラー、画像は残してリトライ可能に
      await supabase.from("pages").update({ status: "error" }).eq("id", pageId);
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("Internal error", { status: 500 });
  }
});
