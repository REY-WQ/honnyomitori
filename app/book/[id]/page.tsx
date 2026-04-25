"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { Book, Page } from "@/lib/types";
import { getBook, addPages, updatePage, deletePage } from "@/lib/storage";
import { compressImage } from "@/lib/compress";

const PARALLEL = 3;

export default function BookPage(props: PageProps<"/book/[id]">) {
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [processing, setProcessing] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [showFullText, setShowFullText] = useState(false);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const retryFileInputRef = useRef<HTMLInputElement>(null);
  const retryPageRef = useRef<Page | null>(null);
  const queueRef = useRef<{ file: File; pageEntry: Page }[]>([]);
  const isRunningRef = useRef(false);
  const bookIdRef = useRef<string>("");

  useEffect(() => {
    (async () => {
      const { id } = await props.params;
      bookIdRef.current = id;
      const b = await getBook(id);
      if (!b) { router.push("/"); return; }
      setBook(b);
    })();
  }, [props.params, router]);

  async function reload() {
    const b = await getBook(bookIdRef.current);
    if (b) setBook({ ...b });
  }

  async function processOne(file: File, pageEntry: Page) {
    try {
      const base64 = await compressImage(file);
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64 }),
      });
      const data = await res.json();
      const updated: Page = {
        ...pageEntry,
        text: data.error ? `エラー: ${data.error}` : (data.text || ""),
        processedAt: new Date().toISOString(),
        status: data.error ? "error" : "done",
      };
      await updatePage(updated);
    } catch (e) {
      await updatePage({ ...pageEntry, text: `エラー: ${e}`, status: "error" });
    }
  }

  async function processQueue() {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setProcessing(true);

    while (queueRef.current.length > 0) {
      const batch = queueRef.current.splice(0, PARALLEL);
      setQueueCount(queueRef.current.length);
      await Promise.all(batch.map(({ file, pageEntry }) => processOne(file, pageEntry)));
      await reload();
    }

    isRunningRef.current = false;
    setProcessing(false);
    setQueueCount(0);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || !book) return;
    const arr = Array.from(files);
    const b = await getBook(book.id);
    if (!b) return;
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
    const processing: Page = { ...page, status: "processing", text: "" };
    await updatePage(processing);
    await reload();
    await processOne(files[0], processing);
    await reload();
  }

  function triggerRetry(page: Page) {
    retryPageRef.current = page;
    retryFileInputRef.current?.click();
  }

  async function handleDeletePage(pageId: string) {
    if (deletingPageId !== pageId) {
      setDeletingPageId(pageId);
      return;
    }
    setDeletingPageId(null);
    await deletePage(pageId);
    await reload();
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
  const errorCount = book.pages.filter((p) => p.status === "error").length;
  const totalChars = donePages.reduce((s, p) => s + p.text.length, 0);
  const fullText = book.pages
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .filter((p) => p.status === "done" || p.status === "error")
    .map((p) => p.status === "error" ? `【ページ${p.pageNumber}：取得失敗】` : p.text)
    .join("\n\n");

  return (
    <main className="min-h-screen bg-gray-50 max-w-lg mx-auto" onClick={() => setDeletingPageId(null)}>
      <div className="bg-white shadow-sm px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push("/")} className="text-gray-400 text-xl">←</button>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-gray-800 text-base leading-tight truncate">{book.title}</h1>
          <p className="text-xs text-gray-400 flex flex-wrap gap-x-1">
            <span>{donePages.length} / {book.pages.length} ページ完了</span>
            {totalChars > 0 && <span>・{totalChars.toLocaleString()}文字</span>}
            {errorCount > 0 && <span className="text-red-400">{errorCount}件エラー</span>}
            {processing && <span className="text-blue-500">処理中…残り{queueCount}枚</span>}
          </p>
        </div>
        {(donePages.length > 0 || errorCount > 0) && (
          <button
            onClick={() => setShowFullText(!showFullText)}
            className="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-xl font-medium shrink-0"
          >
            {showFullText ? "ページ別" : "全文"}
          </button>
        )}
      </div>

      <div className="p-4 flex flex-col gap-4">
        {showFullText ? (
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
              <p className="text-sm font-medium text-gray-700">
                全文（{donePages.length}ページ・{totalChars.toLocaleString()}文字）
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => downloadText(fullText, book.title)}
                  className="text-xs bg-blue-100 text-blue-600 px-3 py-1.5 rounded-xl font-medium"
                >
                  ダウンロード
                </button>
                <button
                  onClick={() => copyText(fullText, "full")}
                  className="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl"
                >
                  {copiedId === "full" ? "コピー済み✓" : "全文コピー"}
                </button>
              </div>
            </div>
            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 max-h-[70vh] overflow-y-auto">
              {fullText || "（テキストなし）"}
            </pre>
          </div>
        ) : (
          <>
            {/* アップロードエリア */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-blue-300 rounded-2xl p-6 text-center bg-white cursor-pointer active:bg-blue-50"
            >
              <p className="text-3xl mb-2">🖼️</p>
              <p className="text-sm font-medium text-blue-600">写真ライブラリから選ぶ（複数可）</p>
              <p className="text-xs text-gray-400 mt-1">100枚まとめて選んでOK・自動で順番に処理します</p>
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

            {/* ページ一覧 */}
            {book.pages.length === 0 ? (
              <div className="text-center text-gray-400 mt-8">
                <p className="text-sm">まだページがありません</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {book.pages.map((page) => (
                  <div key={page.id} className="bg-white rounded-2xl shadow overflow-hidden">
                    <div
                      className="px-4 py-3 flex items-center justify-between"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => setExpandedPage(expandedPage === page.id ? null : page.id)}
                        className="flex-1 text-left min-w-0"
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
                        {page.status === "done" && expandedPage !== page.id && page.text && (
                          <p className="text-xs text-gray-400 mt-0.5 truncate">
                            {page.text.replace(/\n/g, " ").slice(0, 60)}
                          </p>
                        )}
                      </button>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {page.status === "error" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); triggerRetry(page); }}
                            className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full"
                          >
                            再試行
                          </button>
                        )}
                        <span className="text-gray-300 text-sm">{expandedPage === page.id ? "▲" : "▼"}</span>
                        {deletingPageId === page.id ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeletePage(page.id); }}
                            className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full"
                          >
                            確認
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeletePage(page.id); }}
                            className="text-gray-300 hover:text-red-400 text-base"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </div>

                    {expandedPage === page.id && (
                      <div className="px-4 pb-4" onClick={(e) => e.stopPropagation()}>
                        {page.status === "processing" ? (
                          <p className="text-sm text-gray-400 text-center py-4">文字認識中...</p>
                        ) : (
                          <>
                            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 max-h-60 overflow-y-auto">
                              {page.text || "（テキストなし）"}
                            </pre>
                            {page.status === "done" && (
                              <button
                                onClick={() => copyText(page.text, page.id)}
                                className="mt-2 w-full bg-gray-100 text-gray-600 py-2 rounded-xl text-sm"
                              >
                                {copiedId === page.id ? "コピー済み ✓" : "コピー"}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
