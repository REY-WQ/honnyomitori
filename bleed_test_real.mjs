import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://yvvsodbmbtboufzzxnsw.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2dnNvZGJtYnRib3Vmenp4bnN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNjMyMDgsImV4cCI6MjA5MjYzOTIwOH0.L0o1A1o078RdMbbRdujP9s5meJl5NG7jm_Hnk8Hp9h0"
);

// ===== page.tsx の関数を JS にポートしたもの =====

const RE_SENT_END = /[。！？…」』）]$/;

const OVERLAP_PREV_LOOKBACK = 1400;
const OVERLAP_CURR_LOOKAHEAD = 1600;
const OVERLAP_MIN_NORM_CHARS = 45;
const OVERLAP_MAX_NORM_CHARS = 400;
const OVERLAP_STEP_CHARS = 30;
const OVERLAP_LENGTH_FUZZ = 60;
const OVERLAP_MAX_CURR_START = 180;
const IGNORED_OVERLAP_CHARS = new Set([
  ..."　、。，．・･「」『』（）()［］[]【】〈〉《》…‥—―‐‑–_:：;；,.'\"`‘’“”!?！？-",
]);

function isIgnoredOverlapChar(char) {
  return /\s/.test(char) || IGNORED_OVERLAP_CHARS.has(char);
}

function normalizeForOverlap(text) {
  const chars = [];
  const rawStart = [];
  const rawEnd = [];
  let rawIndex = 0;
  for (const rawChar of text) {
    const start = rawIndex;
    rawIndex += rawChar.length;
    const normalized = rawChar.normalize("NFKC").toLowerCase();
    for (const char of normalized) {
      if (isIgnoredOverlapChar(char)) continue;
      chars.push(char);
      rawStart.push(start);
      rawEnd.push(rawIndex);
    }
  }
  return { chars, rawStart, rawEnd };
}

function splitToSentences(text) {
  const results = [];
  let current = "";
  for (const char of text) {
    current += char;
    if ("。！？".includes(char) || char === "\n") {
      if (current.trim()) results.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) results.push(current.trim());
  return results.filter((s) => s.length > 0);
}

function bigramCounts(chars) {
  const counts = new Map();
  for (let i = 0; i < chars.length - 1; i++) {
    const key = chars[i] + chars[i + 1];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function bigramDice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const ac = bigramCounts(a);
  const bc = bigramCounts(b);
  let shared = 0;
  for (const [key, count] of ac) shared += Math.min(count, bc.get(key) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

function commonSubsequenceLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  let curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length];
}

function candidateLengths(max) {
  const values = new Set();
  for (let n = OVERLAP_MIN_NORM_CHARS; n <= max; n += OVERLAP_STEP_CHARS) values.add(n);
  values.add(max);
  return [...values].filter((n) => n >= OVERLAP_MIN_NORM_CHARS).sort((a, b) => a - b);
}

function findFuzzyPageOverlap(prevWindow, currWindow) {
  const prevNorm = normalizeForOverlap(prevWindow);
  const currNorm = normalizeForOverlap(currWindow);
  const maxCurrLen = Math.min(currNorm.chars.length, OVERLAP_MAX_NORM_CHARS);
  const maxPrevSegLen = Math.min(prevNorm.chars.length, OVERLAP_MAX_NORM_CHARS);
  if (maxCurrLen < OVERLAP_MIN_NORM_CHARS || maxPrevSegLen < OVERLAP_MIN_NORM_CHARS) return null;

  const prevBcCache = new Map();
  const prevEndNorm = prevNorm.chars.length;

  let best = null;
  const maxCurrStart = Math.min(OVERLAP_MAX_CURR_START, maxCurrLen - OVERLAP_MIN_NORM_CHARS);
  for (let currStartNorm = 0; currStartNorm <= maxCurrStart; currStartNorm += OVERLAP_STEP_CHARS) {
    const currAvailable = maxCurrLen - currStartNorm;
    for (const currLen of candidateLengths(currAvailable)) {
      const currEndNorm = currStartNorm + currLen;
      const currPart = currNorm.chars.slice(currStartNorm, currEndNorm);
      const currBc = bigramCounts(currPart);
      const prevMin = Math.max(OVERLAP_MIN_NORM_CHARS, currLen - OVERLAP_LENGTH_FUZZ);
      const prevMax = Math.min(maxPrevSegLen, currLen + OVERLAP_LENGTH_FUZZ);
      for (let prevLen = prevMin; prevLen <= prevMax; prevLen += OVERLAP_STEP_CHARS) {
        let prevBc = prevBcCache.get(prevLen);
        if (!prevBc) {
          const ps = prevEndNorm - prevLen;
          const part = prevNorm.chars.slice(ps, prevEndNorm);
          if (part.length < 2) continue;
          prevBc = bigramCounts(part);
          prevBcCache.set(prevLen, prevBc);
        }
        let shared = 0;
        for (const [key, count] of prevBc) shared += Math.min(count, currBc.get(key) ?? 0);
        const dice = (2 * shared) / (prevLen - 1 + currLen - 1);
        if (dice < 0.16) continue;
        const prevStartNorm = prevEndNorm - prevLen;
        const prevPart = prevNorm.chars.slice(prevStartNorm, prevEndNorm);
        const common = commonSubsequenceLength(prevPart, currPart);
        const shortCoverage = common / Math.min(prevLen, currLen);
        const longCoverage = common / Math.max(prevLen, currLen);
        if (common < OVERLAP_MIN_NORM_CHARS || shortCoverage < 0.48 || longCoverage < 0.32) continue;
        const lengthBonus = Math.min(Math.min(prevLen, currLen) / 360, 1) * 0.05;
        const startPenalty = (currStartNorm / Math.max(maxCurrLen, 1)) * 0.18;
        const score = dice * 0.38 + shortCoverage * 0.40 + longCoverage * 0.22 + lengthBonus - startPenalty;
        if (score < 0.38) continue;
        const prevRawStart = prevNorm.rawStart[prevStartNorm] ?? 0;
        const currRawStart = currNorm.rawStart[currStartNorm] ?? 0;
        const currRawEnd = currNorm.rawEnd[currEndNorm - 1] ?? 0;
        const candidate = {
          prevRawStart, currRawStart, currRawEnd,
          prevOverlap: prevWindow.slice(prevRawStart),
          currOverlap: currWindow.slice(currRawStart, currRawEnd),
          score,
          normScore: score + Math.min(currLen, prevLen) / 10000,
        };
        if (!best || candidate.normScore > best.normScore) best = candidate;
      }
    }
  }
  return best;
}

function joinAfterOverlap(prefix, suffix) {
  if (!prefix.trim()) return suffix.trim();
  if (!suffix.trim()) return prefix.trim();
  if (/\s$/.test(prefix) || /^\s/.test(suffix)) return (prefix + suffix).trim();
  return `${prefix.trimEnd()}\n${suffix.trimStart()}`.trim();
}

function overlapSimilarity(a, b) {
  const an = normalizeForOverlap(a).chars;
  const bn = normalizeForOverlap(b).chars;
  if (an.length < 8 || bn.length < 8) return 0;
  const common = commonSubsequenceLength(an, bn);
  const shortCoverage = common / Math.min(an.length, bn.length);
  const longCoverage = common / Math.max(an.length, bn.length);
  return bigramDice(an, bn) * 0.35 + shortCoverage * 0.45 + longCoverage * 0.20;
}

function segmentQuality(text) {
  const normalizedLength = Math.min(normalizeForOverlap(text).chars.length, 220);
  const hasSentenceEnd = RE_SENT_END.test(text.trim()) ? 12 : 0;
  const replacementPenalty = (text.match(/[�□■◇◆]/g)?.length ?? 0) * 10;
  const straySymbolPenalty = (text.match(/[|\\~^]{2,}/g)?.length ?? 0) * 8;
  const naturalPatterns = [/できるような/g, /している/g, /されている/g, /られている/g, /ものである/g, /なのである/g, /については/g, /というのも/g, /すなわち/g, /であるから/g, /とするならば/g, /において/g, /に対して/g, /として/g, /一瞬で/g, /ではなく/g, /そうしたこと/g, /化学反応/g, /二次性質/g, /存在していた/g, /主張すること/g];
  const brokenPatterns = [/[一-龯々]{1,4}な(視点|感覚|性質|関係|外部|内部|対象|もの)/g, /[がのをにへとでやりるか]{5,}/g, /[一-龯々]{1,4}心ではない/g, /次性質/g, /測定存能/g, /[一-龯々ぁ-んァ-ン]ー[ぁ-ん]/g, /[ァ-ンー]{3,}$/g, /そうした[でにをが]/g, /とか、[^。！？]{0,4}こと/g, /[ぁ-んァ-ン一-龯々]{2,8}$/g, /ずから/g, /がられている/g, /がりゆる/g, /与えるみ$/g];
  const naturalBonus = naturalPatterns.reduce((sum, p) => sum + ((text.match(p)?.length ?? 0) * 12), 0);
  const brokenPenalty = brokenPatterns.reduce((sum, p) => sum + ((text.match(p)?.length ?? 0) * 18), 0);
  const danglingPenalty = RE_SENT_END.test(text.trim()) ? 0 : 10;
  return normalizedLength + hasSentenceEnd + naturalBonus - replacementPenalty - straySymbolPenalty - brokenPenalty - danglingPenalty;
}

function longestCommonSuffixPrefix(prefixText, fullText) {
  let best = { length: 0, completeEnd: -1 };
  for (let end = 1; end <= fullText.length; end++) {
    const maxLen = Math.min(prefixText.length, end);
    for (let len = maxLen; len >= 1; len--) {
      if (prefixText.slice(prefixText.length - len) === fullText.slice(end - len, end)) {
        if (len > best.length) best = { length: len, completeEnd: end };
        break;
      }
    }
  }
  return best;
}

function completeDanglingSegment(a, b) {
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (!aTrim || !bTrim) return null;
  const aComplete = RE_SENT_END.test(aTrim);
  const bComplete = RE_SENT_END.test(bTrim);
  if (aComplete === bComplete) return null;
  const dangling = aComplete ? bTrim : aTrim;
  const complete = aComplete ? aTrim : bTrim;
  if (normalizeForOverlap(dangling).chars.length < 40) return null;
  if (overlapSimilarity(dangling, complete) < 0.72) return null;
  const dNorm = normalizeForOverlap(dangling);
  const cNorm = normalizeForOverlap(complete);
  const common = commonSubsequenceLength(dNorm.chars, cNorm.chars);
  if (common / Math.max(dNorm.chars.length, 1) < 0.88) return null;
  const danglingTail = dangling.slice(Math.max(0, dangling.length - 24));
  const completeTailWindow = complete.slice(Math.max(0, complete.length - 80));
  const anchor = longestCommonSuffixPrefix(danglingTail, completeTailWindow);
  if (anchor.length < 2) return null;
  const append = completeTailWindow.slice(anchor.completeEnd);
  if (append.length === 0 || append.length > 12) return null;
  if (!RE_SENT_END.test((dangling + append).trim())) return null;
  return (dangling + append).trim();
}

function chooseBetterOverlapSegment(prevSegment, currSegment) {
  const completed = completeDanglingSegment(prevSegment, currSegment);
  if (completed) {
    if (globalThis.__debugChoose) console.log(`    [choose] completed → "${completed.slice(0,40)}"`);
    return completed;
  }
  const prevTrim = prevSegment.trim();
  const currTrim = currSegment.trim();
  const prevIncomplete = !RE_SENT_END.test(prevTrim);
  const currIncomplete = !RE_SENT_END.test(currTrim);
  if (prevIncomplete && currIncomplete) {
    if (currTrim.length > prevTrim.length && currTrim.startsWith(prevTrim)) {
      if (globalThis.__debugChoose) console.log(`    [choose] both incomplete, curr extends prev → curr`);
      return currTrim;
    }
    if (prevTrim.length > currTrim.length && prevTrim.startsWith(currTrim)) {
      if (globalThis.__debugChoose) console.log(`    [choose] both incomplete, prev extends curr → prev`);
      return prevTrim;
    }
  }
  const prevScore = segmentQuality(prevSegment);
  const currScore = segmentQuality(currSegment);
  let chosen;
  if (prevScore >= currScore * 0.92 && prevScore <= currScore * 1.08) {
    chosen = prevSegment.length >= currSegment.length ? prevSegment : currSegment;
  } else {
    chosen = prevScore > currScore ? prevSegment : currSegment;
  }
  if (globalThis.__debugChoose) {
    const pn = normalizeForOverlap(prevSegment).chars.length;
    const cn = normalizeForOverlap(currSegment).chars.length;
    console.log(`    [choose] prev="${prevSegment.slice(0,40)}..." (raw=${prevSegment.length}, norm=${pn}, Q=${prevScore})`);
    console.log(`             curr="${currSegment.slice(0,40)}..." (raw=${currSegment.length}, norm=${cn}, Q=${currScore})`);
    console.log(`             → ${chosen === prevSegment ? "prev" : "curr"}`);
  }
  return chosen;
}

function processOverlap(prevOverlap, currOverlap) {
  const prevSegments = splitToSentences(prevOverlap);
  const currSegments = splitToSentences(currOverlap);
  if (prevSegments.length === 0 || currSegments.length === 0) {
    return { newPrevOverlap: prevOverlap, newCurrOverlap: currOverlap, debug: { prevSegments, currSegments, decisions: [] } };
  }
  const prevReplace = new Map();
  const currDelete = new Set();
  const decisions = [];
  let prevIndex = 0;
  let lastMatchedPrevIdx = -1;
  let firstMatchedCurrIdx = -1;
  for (let j = 0; j < currSegments.length; j++) {
    const currSeg = currSegments[j];
    let bestIndex = -1;
    let bestScore = 0;
    const searchEnd = Math.min(prevSegments.length, prevIndex + 7);
    for (let i = prevIndex; i < searchEnd; i++) {
      const score = overlapSimilarity(prevSegments[i], currSeg);
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    if (bestIndex < 0 || bestScore < 0.38) {
      decisions.push({ curr: currSeg, action: "no-match", score: bestScore.toFixed(2) });
      continue;
    }
    const prevSeg = prevSegments[bestIndex];
    const winner = chooseBetterOverlapSegment(prevSeg, currSeg);
    if (winner === prevSeg) {
      decisions.push({ curr: currSeg, action: "prev勝ち (curr削除)", score: bestScore.toFixed(2) });
      currDelete.add(j);
    } else if (winner === currSeg) {
      decisions.push({ curr: currSeg, action: "curr勝ち (prev削除)", score: bestScore.toFixed(2) });
      prevReplace.set(bestIndex, null);
    } else {
      decisions.push({ curr: currSeg, action: "補完版 (prevを置換, curr削除)", score: bestScore.toFixed(2) });
      prevReplace.set(bestIndex, winner);
      currDelete.add(j);
    }
    prevIndex = bestIndex + 1;
    lastMatchedPrevIdx = bestIndex;
    if (firstMatchedCurrIdx === -1) firstMatchedCurrIdx = j;
  }
  // 前ページ：最後にマッチした文より「後ろ」にあるマッチしてない文は削除
  for (let i = lastMatchedPrevIdx + 1; i < prevSegments.length; i++) {
    if (!prevReplace.has(i)) prevReplace.set(i, null);
  }
  // 次ページ：最初にマッチした文より「前」にあるマッチしてない文は削除
  if (firstMatchedCurrIdx > 0) {
    for (let j = 0; j < firstMatchedCurrIdx; j++) {
      if (!currDelete.has(j)) currDelete.add(j);
    }
  }
  const newPrevOverlap = prevSegments.map((seg, i) => {
    if (prevReplace.has(i)) {
      const v = prevReplace.get(i);
      return v === null ? "" : v;
    }
    return seg;
  }).join("").trim();
  const newCurrOverlap = currSegments.map((seg, j) => currDelete.has(j) ? "" : seg).join("").trim();
  return { newPrevOverlap, newCurrOverlap, debug: { prevSegments, currSegments, decisions } };
}

function findSentenceBoundaryBefore(text, position) {
  for (let i = position - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "。" || c === "！" || c === "？" || c === "\n") return i + 1;
  }
  return 0;
}

function removeBleedThroughHead(currText, prevText) {
  const prevWindowStart = Math.max(0, prevText.length - OVERLAP_PREV_LOOKBACK);
  const prevWindow = prevText.slice(prevWindowStart);
  const currWindow = currText.slice(0, OVERLAP_CURR_LOOKAHEAD);
  const overlap = findFuzzyPageOverlap(prevWindow, currWindow);
  if (!overlap) return null;
  const prevSentenceStart = findSentenceBoundaryBefore(prevWindow, overlap.prevRawStart);
  const expandedPrevOverlap = prevWindow.slice(prevSentenceStart);
  const currOverlap = currText.slice(overlap.currRawStart, overlap.currRawEnd);
  const removedPre = currText.slice(0, overlap.currRawStart);
  const { newPrevOverlap, newCurrOverlap, debug } = processOverlap(expandedPrevOverlap, currOverlap);
  const keptText = newCurrOverlap
    ? joinAfterOverlap(newCurrOverlap, currText.slice(overlap.currRawEnd))
    : currText.slice(overlap.currRawEnd).trim();
  let newPrevText = null;
  if (newPrevOverlap !== expandedPrevOverlap.trim()) {
    newPrevText = (prevText.slice(0, prevWindowStart + prevSentenceStart) + newPrevOverlap).trim();
  }
  return { overlap, currOverlap, removedPre, mergedOverlap: newPrevOverlap, keptText, newPrevText, prevSentenceStart, debug };
}

// ===== テスト実行 =====

const { data: pages, error } = await supabase
  .from("pages")
  .select("id, chapter_id, page_number, text, status")
  .eq("status", "done")
  .order("chapter_id")
  .order("page_number");

if (error) { console.error(error); process.exit(1); }

const { data: books } = await supabase.from("books").select("id, title");
const { data: chapterRows } = await supabase.from("chapters").select("id, book_id, name");
const bookMap = Object.fromEntries(books.map((b) => [b.id, b.title]));
const chapterMap = Object.fromEntries(chapterRows.map((c) => [c.id, c.name]));
const chapterToBook = Object.fromEntries(chapterRows.map((c) => [c.id, c.book_id]));

// テスト2 ブックのチャプターだけ抽出
const targetBookIds = new Set(books.filter((b) => b.title === "テスト2").map((b) => b.id));
const targetChapterIds = new Set(chapterRows.filter((c) => targetBookIds.has(c.book_id)).map((c) => c.id));

const byChapter = {};
for (const p of pages) {
  if (!targetChapterIds.has(p.chapter_id)) continue;
  (byChapter[p.chapter_id] ??= []).push(p);
}

let totalPairs = 0, detected = 0, kept = 0;

for (const [chapterId, chPages] of Object.entries(byChapter)) {
  const sorted = chPages.sort((a, b) => a.page_number - b.page_number);
  console.log(`\n========== ${bookMap[chapterToBook[chapterId]]} > ${chapterMap[chapterId]} (${sorted.length}ページ) ==========`);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev.text || !curr.text) continue;
    totalPairs++;

    globalThis.__debugChoose = (curr.page_number === 9);
    const result = removeBleedThroughHead(curr.text, prev.text);
    globalThis.__debugChoose = false;
    if (!result) continue;
    detected++;

    console.log(`\n${"━".repeat(70)}`);
    console.log(`p.${prev.page_number} → p.${curr.page_number}  score=${result.overlap.score.toFixed(3)}`);
    console.log(`${"━".repeat(70)}`);

    const prevTailBefore = prev.text.slice(-150);
    const currHeadBefore = curr.text.slice(0, 300);
    const prevTailAfter = result.newPrevText ? result.newPrevText.slice(-150) : prevTailBefore;
    const currHeadAfter = result.keptText.slice(0, 300);

    console.log(`【処理前】 …${prev.page_number}末尾 ▶ ${curr.page_number}先頭`);
    console.log(`  …${prevTailBefore.replace(/\n/g, "↵")}`);
    console.log(`  ▶ ${currHeadBefore.replace(/\n/g, "↵")}`);
    console.log(`\n【処理後】 …${prev.page_number}末尾 ▶ ${curr.page_number}先頭`);
    console.log(`  …${prevTailAfter.replace(/\n/g, "↵")}`);
    console.log(`  ▶ ${currHeadAfter.replace(/\n/g, "↵")}`);
    if (result.removedPre) {
      console.log(`\n【curr 先頭〜重なり前の独立断片（巻き込み削除）】`);
      console.log(`  「${result.removedPre.replace(/\n/g, "↵").slice(0, 150)}」`);
    }
    console.log(`\n【文単位判定】`);
    for (const d of result.debug.decisions) {
      console.log(`  ${d.action.padEnd(30)}(${d.score})  「${d.curr.slice(0, 50)}」`);
    }
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log(`合計: ${totalPairs}ペア / 検出 ${detected}件`);
