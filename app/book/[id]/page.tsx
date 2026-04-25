"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { Book, Page } from "@/lib/types";
import { getBook, addPages, updatePage, deletePage } from "@/lib/storage";
import { getSupabase } from "@/lib/supabase";
import { compressImage } from "@/lib/compress";

const PARALLEL = 3;
const OCR_TIMEOUT_MS = 30000;

function parseOcrError(msg: string): string {
  if (msg.includes("API key not valid") || msg.includes("API_KEY_INVALID")) return "APIキーが無効です（Google Cloudで確認が必要）";
  if (msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) return "API利用上限に達しました。しばらく待ってください";
  if (msg.includes("billing") || msg.includes("BILLING")) return "Google Cloudの請求設定が必要です";
  if (msg.includes("not enabled") || msg.includes("SERVICE_DISABLED")) return "Cloud Vision APIが有効になっていません";
  if (msg.includes("AbortError") || msg.includes("abort")) return "タイムアウト（30秒）。通信が遅い可能性があります";
  return msg;
}

export default function BookPage(props: PageProps<"/book/[id]">) {
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [processing, setProcessing] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [showFullText, setShowFullText] = useState(false);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [stuckCount, setStuckCount] = useState(0);
  const [fileReading, setFileReading] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [fullTextSeparated, setFullTextSeparated] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const retryFileInputRef = useRef<HTMLInputElement>(null);
  const retryPageRef = useRef<Page | null>(null);
  const queueRef = useRef<{ file: File; pageEntry: Page }[]>([]);
  const isRunningRef = useRef(false);
  const bookIdRef = useRef<string>("");
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const hasAutoSelectedRef = useRef(false);

  async function acquireWakeLock() {
    try {
      if ("wakeLock" in navigator) wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch { /* 非対応端末は無視 */ }
  }
  function releaseWakeLock() {
    wakeLockRef.current?.release();
    wakeLockRef.current = null;
  }

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    (async () => {
      const { id } = await props.params;
      bookIdRef.current = id;
      const b = await getBook(id);
      if (!b) { router.push("/"); return; }
      const stuck = b.pages.filter((p) => p.status === "processing");
      if (stuck.length > 0) setStuckCount(stuck.length);
      setBook(b);

      // デスクトップで初回ロード時に最初のページを自動選択
      if (!hasAutoSelectedRef.current && b.pages.length > 0 && typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
        hasAutoSelectedRef.current = true;
        setSelectedPageId(b.pages[0].id);
      }

      const supabase = getSupabase();
      const channel = supabase
        .channel(`pages-${id}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "pages", filter: `book_id=eq.${id}` }, () => {
          reload();
        })
        .subscribe();
      cleanup = () => { supabase.removeChannel(channel); };
    })();
    return () => { cleanup?.(); };
  }, [props.params, router]);

  async function reload() {
    const b = await getBook(bookIdRef.current);
    if (b) setBook({ ...b });
  }

  // キーボードナビゲーション（矢印キーでページ移動）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingText !== null) return;
      if (!book || book.pages.length === 0) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const pages = book.pages;
      const idx = selectedPageId ? pages.findIndex((p) => p.id === selectedPageId) : -1;

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = pages[idx + 1] ?? pages[0];
        setSelectedPageId(next.id);
        setShowFullText(false);
        document.getElementById(`page-${next.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = pages[idx - 1] ?? pages[pages.length - 1];
        setSelectedPageId(prev.id);
        setShowFullText(false);
        document.getElementById(`page-${prev.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPageId, editingText, book]);

  async function processOne(file: File, pageEntry: Page) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
    try {
      const base64 = await compressImage(file);
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64 }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json();
      const errMsg = data.error ? parseOcrError(data.error) : null;
      await updatePage({
        ...pageEntry,
        text: errMsg ? `エラー: ${errMsg}` : (data.text || ""),
        processedAt: new Date().toISOString(),
        status: errMsg ? "error" : "done",
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e instanceof Error) ? parseOcrError(e.message) : String(e);
      await updatePage({ ...pageEntry, text: `エラー: ${msg}`, status: "error" });
    }
  }

  async function processQueue() {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setProcessing(true);
    await acquireWakeLock();

    while (queueRef.current.length > 0) {
      const batch = queueRef.current.splice(0, PARALLEL);
      setQueueCount(queueRef.current.length);
      await Promise.all(batch.map(({ file, pageEntry }) => processOne(file, pageEntry)));
      await reload();
    }

    isRunningRef.current = false;
    setProcessing(false);
    setQueueCount(0);
    releaseWakeLock();
  }

  async function handleFiles(files: FileList | null) {
    if (!files || !book) return;
    setFileReading(true);
    const arr = Array.from(files);
    const b = await getBook(book.id);
    if (!b) { setFileReading(false); return; }
    const startPage = b.pages.length + 1;

    const entries: { file: File; pageEntry: Page }[] = arr.map((file, i) => ({
      file,
      pageEntry: {
        id: uuidv4(),
        pageNumber: startPage + i,
        text: "",
        processedAt: "",
        status: "processing" as const,
      },
    }));

    await addPages(book.id, entries.map((e) => e.pageEntry));
    await reload();
    setFileReading(false);
    queueRef.current.push(...entries);
    setQueueCount(queueRef.current.length);
    if (fileInputRef.current) fileInputRef.current.value = "";
    processQueue();
  }

  async function handleRetryFile(files: FileList | null) {
    const page = retryPageRef.current;
    if (!files || !files[0] || !page) return;
    retryPageRef.current = null;
    if (retryFileInputRef.current) retryFileInputRef.current.value = "";
    const retrying: Page = { ...page, status: "processing", text: "" };
    await updatePage(retrying);
    await reload();
    await processOne(files[0], retrying);
    await reload();
  }

  function triggerRetry(page: Page) {
    retryPageRef.current = page;
    retryFileInputRef.current?.click();
  }

  async function resetStuckPages() {
    if (!book) return;
    const stuck = book.pages.filter((p) => p.status === "processing");
    await Promise.all(stuck.map((p) => updatePage({ ...p, status: "error", text: "処理が中断されました" })));
    setStuckCount(0);
    await reload();
  }

  async function handleDeletePage(pageId: string) {
    if (deletingPageId !== pageId) { setDeletingPageId(pageId); return; }
    setDeletingPageId(null);
    if (selectedPageId === pageId) setSelectedPageId(null);
    await deletePage(pageId);
    await reload();
  }

  async function saveEdit(page: Page) {
    if (editingText === null) return;
    setSavingEdit(true);
    await updatePage({ ...page, text: editingText });
    setSavingEdit(false);
    setEditingText(null);
    await reload();
  }

  function startEdit(page: Page) {
    setEditingText(page.text);
  }

  function copyText(text: string, id?: string) {
    navigator.clipboard.writeText(text);
    if (id) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  }

  function downloadText(text: string, title: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!book) return <div className="p-6 text-gray-400 text-center">読み込み中...</div>;

  const donePages = book.pages.filter((p) => p.status === "done");
  const processingPages = book.pages.filter((p) => p.status === "processing");
  const errorCount = book.pages.filter((p) => p.status === "error").length;
  const totalChars = donePages.reduce((s, p) => s + p.text.length, 0);
  const finishedCount = book.pages.length - processingPages.length;
  const progressPct = book.pages.length > 0 ? Math.round((finishedCount / book.pages.length) * 100) : 0;
  const selectedPage = book.pages.find((p) => p.id === selectedPageId) ?? null;

  const filteredPages = searchQuery.trim()
    ? book.pages.filter((p) =>
        p.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(p.pageNumber).includes(searchQuery)
      )
    : book.pages;

  const fullTextPlain = book.pages
    .slice().sort((a, b) => a.pageNumber - b.pageNumber)
    .filter((p) => p.status === "done" || p.status === "error")
    .map((p) => p.status === "error" ? `【ページ${p.pageNumber}：取得失敗】` : p.text)
    .join("\n\n");

  const fullTextSep = book.pages
    .slice().sort((a, b) => a.pageNumber - b.pageNumber)
    .filter((p) => p.status === "done" || p.status === "error")
    .map((p) => p.status === "error"
      ? `── ページ ${p.pageNumber} ──\n【取得失敗】`
      : `── ページ ${p.pageNumber} ──\n${p.text}`)
    .join("\n\n");

  const fullText = fullTextSeparated ? fullTextSep : fullTextPlain;

  // --------- 右パネルコンテンツ ---------
  function RightPanel() {
    if (showFullText) {
      return (
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div>
              <p className="text-sm font-semibold text-gray-700">全文</p>
              <p className="text-xs text-gray-400">{donePages.length}ページ・{totalChars.toLocaleString()}文字</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setFullTextSeparated(!fullTextSeparated)}
                className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl active:scale-95 transition-transform"
              >
                {fullTextSeparated ? "区切りなし" : "ページ区切り"}
              </button>
              <button
                onClick={() => downloadText(fullText, book!.title)}
                className="text-xs bg-blue-100 text-blue-600 px-3 py-1.5 rounded-xl font-medium active:scale-95 transition-transform"
              >
                DL
              </button>
              <button
                onClick={() => copyText(fullText, "full")}
                className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl active:scale-95 transition-transform"
              >
                {copiedId === "full" ? "コピー済み✓" : "全文コピー"}
              </button>
            </div>
          </div>
          <pre className="flex-1 text-sm text-gray-700 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 overflow-y-auto min-h-0">
            {fullText || "（テキストなし）"}
          </pre>
        </div>
      );
    }

    if (!selectedPage) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-gray-300">
          <p className="text-5xl mb-4">📄</p>
          <p className="text-sm">左のページを選んでください</p>
          <p className="text-xs mt-1">矢印キー ← → でもナビゲートできます</p>
        </div>
      );
    }

    const pages = book!.pages;
    const currentIdx = pages.findIndex((p) => p.id === selectedPage.id);
    const prevPage = pages[currentIdx - 1] ?? null;
    const nextPage = pages[currentIdx + 1] ?? null;

    const isEditing = editingText !== null;
    return (
      <div className="flex flex-col h-full">
        {/* ページナビゲーション */}
        <div className="flex items-center justify-between mb-2 text-xs text-gray-400">
          <button
            onClick={() => { if (prevPage) { setSelectedPageId(prevPage.id); setEditingText(null); } }}
            disabled={!prevPage}
            className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 disabled:opacity-30 active:scale-95 transition-transform"
          >
            ← {prevPage ? `ページ${prevPage.pageNumber}` : ""}
          </button>
          <span className="text-gray-400">{currentIdx + 1} / {pages.length}</span>
          <button
            onClick={() => { if (nextPage) { setSelectedPageId(nextPage.id); setEditingText(null); } }}
            disabled={!nextPage}
            className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 disabled:opacity-30 active:scale-95 transition-transform"
          >
            {nextPage ? `ページ${nextPage.pageNumber}` : ""} →
          </button>
        </div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-gray-700">ページ {selectedPage.pageNumber}</p>
            {selectedPage.status === "done" && (
              <p className="text-xs text-gray-400">{selectedPage.text.length.toLocaleString()}文字</p>
            )}
          </div>
          <div className="flex gap-1.5">
            {selectedPage.status === "error" && (
              <button
                onClick={() => triggerRetry(selectedPage)}
                className="text-xs bg-orange-100 text-orange-600 px-2.5 py-1.5 rounded-xl active:scale-95 transition-transform"
              >
                再試行
              </button>
            )}
            {selectedPage.status === "done" && !isEditing && (
              <button
                onClick={() => startEdit(selectedPage)}
                className="text-xs bg-blue-100 text-blue-600 px-2.5 py-1.5 rounded-xl active:scale-95 transition-transform"
              >
                ✏️ 編集
              </button>
            )}
            <button
              onClick={() => { setDeletingPageId(deletingPageId === selectedPage.id ? null : selectedPage.id); }}
              className="text-xs bg-gray-100 text-gray-500 px-2.5 py-1.5 rounded-xl active:scale-95 transition-transform"
            >
              🗑️
            </button>
            {deletingPageId === selectedPage.id && (
              <button
                onClick={() => handleDeletePage(selectedPage.id)}
                className="text-xs bg-red-500 text-white px-2.5 py-1.5 rounded-xl active:scale-95 transition-transform"
              >
                削除確認
              </button>
            )}
          </div>
        </div>

        {selectedPage.status === "processing" ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-gray-400 animate-pulse">文字認識中...</p>
          </div>
        ) : isEditing ? (
          <div className="flex flex-col flex-1 gap-2 min-h-0">
            <textarea
              className="flex-1 text-sm text-gray-700 font-sans bg-gray-50 rounded-xl p-3 resize-none outline-none focus:ring-2 focus:ring-blue-300 min-h-0"
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => saveEdit(selectedPage)}
                disabled={savingEdit}
                className="flex-1 bg-blue-600 text-white py-2 rounded-xl text-sm font-medium active:scale-95 transition-transform disabled:opacity-50"
              >
                {savingEdit ? "保存中..." : "保存"}
              </button>
              <button
                onClick={() => setEditingText(null)}
                className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-xl text-sm active:scale-95 transition-transform"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 gap-2 min-h-0">
            <pre className="flex-1 text-sm text-gray-700 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 overflow-y-auto min-h-0">
              {selectedPage.text || "（テキストなし）"}
            </pre>
            {selectedPage.status === "done" && (
              <button
                onClick={() => copyText(selectedPage.text, selectedPage.id)}
                className="shrink-0 w-full bg-gray-100 text-gray-600 py-2 rounded-xl text-sm active:scale-95 transition-transform"
              >
                {copiedId === selectedPage.id ? "コピー済み ✓" : "コピー"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" onClick={() => setDeletingPageId(null)}>
      {/* ヘッダー */}
      <div className="bg-white shadow-sm px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push("/")} className="text-gray-400 text-xl active:scale-90 transition-transform">←</button>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-gray-800 text-base leading-tight truncate">{book.title}</h1>
          <p className="text-xs text-gray-400 flex flex-wrap gap-x-1">
            <span>{donePages.length} / {book.pages.length} ページ完了</span>
            {totalChars > 0 && <span>・{totalChars.toLocaleString()}文字</span>}
            {errorCount > 0 && <span className="text-red-400">・{errorCount}件エラー</span>}
            {processing && <span className="text-blue-500">・処理中…残り{queueCount}枚</span>}
            {fileReading && <span className="text-orange-500">・ファイル読み込み中...</span>}
          </p>
          {processingPages.length > 0 && (
            <div className="mt-1.5 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
              <div className="bg-blue-500 h-full rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>
        {(donePages.length > 0 || errorCount > 0) && (
          <button
            onClick={() => { setShowFullText(!showFullText); setSelectedPageId(null); }}
            className="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-xl font-medium shrink-0 active:scale-95 transition-transform"
          >
            {showFullText ? "ページ別" : "全文"}
          </button>
        )}
      </div>

      {/* 中断されたページの警告 */}
      {stuckCount > 0 && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-2 flex items-center gap-2">
          <p className="text-xs text-yellow-700 flex-1">前回の処理が中断されたページが{stuckCount}件あります</p>
          <button
            onClick={resetStuckPages}
            className="text-xs bg-yellow-200 text-yellow-800 px-3 py-1 rounded-xl active:scale-95 transition-transform"
          >
            エラーにリセット
          </button>
        </div>
      )}

      {/* メインコンテンツ（モバイル: 1カラム、デスクトップ: 2カラム） */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左パネル（ページリスト） */}
        <div className="flex-1 md:flex-none md:w-80 md:border-r md:border-gray-200 overflow-y-auto">
          <div className="p-4 flex flex-col gap-3">
            {/* アップロードエリア */}
            {!showFullText && (
              <div
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-5 text-center bg-white cursor-pointer transition-colors ${fileReading ? "border-orange-300 bg-orange-50" : "border-blue-300 active:bg-blue-50"}`}
              >
                {fileReading ? (
                  <>
                    <p className="text-2xl mb-1.5">⏳</p>
                    <p className="text-sm font-medium text-orange-600">ファイルを読み込み中...</p>
                  </>
                ) : (
                  <>
                    <p className="text-2xl mb-1.5">🖼️</p>
                    <p className="text-sm font-medium text-blue-600">写真ライブラリから選ぶ（複数可）</p>
                    <p className="text-xs text-gray-400 mt-0.5">100枚まとめて選んでOK</p>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <input
                  ref={retryFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
                  className="hidden"
                  onChange={(e) => handleRetryFile(e.target.files)}
                />
              </div>
            )}

            {/* 検索バー */}
            {book.pages.length > 3 && (
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 text-sm">🔍</span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ページ内を検索..."
                  className="w-full bg-white border border-gray-200 rounded-xl pl-8 pr-3 py-2 text-sm outline-none focus:border-blue-400"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">✕</button>
                )}
              </div>
            )}

            {/* ページ一覧 */}
            {book.pages.length === 0 ? (
              <div className="text-center text-gray-400 mt-8">
                <p className="text-sm">まだページがありません</p>
              </div>
            ) : filteredPages.length === 0 ? (
              <div className="text-center text-gray-400 mt-4">
                <p className="text-sm">「{searchQuery}」に一致するページが見つかりません</p>
              </div>
            ) : (
              filteredPages.map((page) => {
                const isSelected = selectedPageId === page.id;
                return (
                  <div key={page.id} id={`page-${page.id}`} className={`bg-white rounded-2xl shadow overflow-hidden transition-all ${isSelected ? "ring-2 ring-blue-400" : ""}`}>
                    <div className="px-4 py-3 flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
                      {/* ページ選択ボタン */}
                      <button
                        onClick={() => { setSelectedPageId(isSelected ? null : page.id); setShowFullText(false); setEditingText(null); }}
                        className="flex-1 text-left min-w-0 active:opacity-70 transition-opacity"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-700 shrink-0">ページ {page.pageNumber}</span>
                          {page.status === "processing" && (
                            <span className="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full animate-pulse shrink-0">処理中</span>
                          )}
                          {page.status === "done" && (
                            <>
                              <span className="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full shrink-0">完了</span>
                              <span className="text-xs text-gray-400 shrink-0">{page.text.length.toLocaleString()}文字</span>
                            </>
                          )}
                          {page.status === "error" && (
                            <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full shrink-0">エラー</span>
                          )}
                        </div>
                        {page.status === "done" && !isSelected && page.text && (
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{page.text.replace(/\n/g, " ").slice(0, 60)}</p>
                        )}
                      </button>

                      {/* アクションボタン（モバイルのみ） */}
                      <div className="flex items-center gap-1.5 shrink-0 ml-2 md:hidden">
                        {page.status === "error" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); triggerRetry(page); }}
                            className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full active:scale-95 transition-transform"
                          >
                            再試行
                          </button>
                        )}
                        {deletingPageId === page.id ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeletePage(page.id); }}
                            className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full active:scale-95 transition-transform"
                          >
                            確認
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeletePage(page.id); }}
                            className="text-gray-300 hover:text-red-400 text-base active:scale-95 transition-transform"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </div>

                    {/* モバイルのみ: 選択されたページのインライン展開 */}
                    {isSelected && (
                      <div className="md:hidden px-4 pb-4" onClick={(e) => e.stopPropagation()}>
                        {page.status === "processing" ? (
                          <p className="text-sm text-gray-400 text-center py-4 animate-pulse">文字認識中...</p>
                        ) : editingText !== null && selectedPageId === page.id ? (
                          <div className="flex flex-col gap-2">
                            <textarea
                              className="w-full h-48 text-sm text-gray-700 font-sans bg-gray-50 rounded-xl p-3 resize-none outline-none focus:ring-2 focus:ring-blue-300"
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              autoFocus
                            />
                            <div className="flex gap-2">
                              <button onClick={() => saveEdit(page)} disabled={savingEdit} className="flex-1 bg-blue-600 text-white py-2 rounded-xl text-sm font-medium active:scale-95 transition-transform disabled:opacity-50">
                                {savingEdit ? "保存中..." : "保存"}
                              </button>
                              <button onClick={() => setEditingText(null)} className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-xl text-sm active:scale-95 transition-transform">キャンセル</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 max-h-60 overflow-y-auto">
                              {page.text || "（テキストなし）"}
                            </pre>
                            <div className="flex gap-2 mt-2">
                              {page.status === "done" && (
                                <>
                                  <button onClick={() => copyText(page.text, page.id)} className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-xl text-sm active:scale-95 transition-transform">
                                    {copiedId === page.id ? "コピー済み ✓" : "コピー"}
                                  </button>
                                  <button onClick={() => startEdit(page)} className="flex-1 bg-blue-100 text-blue-600 py-2 rounded-xl text-sm active:scale-95 transition-transform">
                                    ✏️ 編集
                                  </button>
                                </>
                              )}
                              {page.status === "error" && (
                                <button onClick={() => triggerRetry(page)} className="flex-1 bg-orange-100 text-orange-600 py-2 rounded-xl text-sm active:scale-95 transition-transform">再試行</button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右パネル（デスクトップのみ） */}
        <div className="hidden md:flex flex-col flex-1 p-4 overflow-y-auto">
          <RightPanel />
        </div>
      </div>
    </div>
  );
}
