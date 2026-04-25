"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { Book, Page } from "@/lib/types";
import { getBook, updateBook } from "@/lib/storage";
import { compressImage } from "@/lib/compress";

const PARALLEL = 3;

export default function BookPage(props: PageProps<"/book/[id]">) {
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [processing, setProcessing] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<{ file: File; pageEntry: Page }[]>([]);
  const isRunningRef = useRef(false);
  const bookIdRef = useRef<string>("");

  useEffect(() => {
    (async () => {
      const { id } = await props.params;
      bookIdRef.current = id;
      const b = getBook(id);
      if (!b) { router.push("/"); return; }
      setBook(b);
    })();
  }, [props.params, router]);

  function reload() {
    const b = getBook(bookIdRef.current);
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
      const latest = getBook(bookIdRef.current)!;
      const pg = latest.pages.find((p) => p.id === pageEntry.id)!;
      pg.text = data.text || "";
      pg.processedAt = new Date().toISOString();
      pg.status = data.error ? "error" : "done";
      updateBook(latest);
    } catch {
      const latest = getBook(bookIdRef.current)!;
      const pg = latest.pages.find((p) => p.id === pageEntry.id)!;
      pg.status = "error";
      updateBook(latest);
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
      reload();
    }

    isRunningRef.current = false;
    setProcessing(false);
    setQueueCount(0);
  }

  async function handleFiles(files: FileList | null) {
    if (!files || !book) return;
    const arr = Array.from(files);

    const b = getBook(book.id)!;
    const startPage = b.pages.length + 1;

    const entries = arr.map((file, i) => {
      const pageEntry: Page = {
        id: uuidv4(),
        pageNumber: startPage + i,
        text: "",
        processedAt: "",
        status: "processing",
      };
      b.pages.push(pageEntry);
      return { file, pageEntry };
    });

    updateBook(b);
    reload();
    queueRef.current.push(...entries);
    setQueueCount(queueRef.current.length);

    if (fileInputRef.current) fileInputRef.current.value = "";
    processQueue();
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
  }

  if (!book) return <div className="p-6 text-gray-400 text-center">読み込み中...</div>;

  const doneCount = book.pages.filter((p) => p.status === "done").length;
  const errorCount = book.pages.filter((p) => p.status === "error").length;

  return (
    <main className="min-h-screen bg-gray-50 max-w-lg mx-auto">
      <div className="bg-white shadow-sm px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push("/")} className="text-gray-400 text-xl">←</button>
        <div className="flex-1">
          <h1 className="font-bold text-gray-800 text-base leading-tight">{book.title}</h1>
          <p className="text-xs text-gray-400">
            {doneCount} / {book.pages.length} ページ完了
            {errorCount > 0 && <span className="ml-1 text-red-400">{errorCount}件エラー</span>}
            {processing && <span className="ml-2 text-blue-500">処理中…残り{queueCount}枚</span>}
          </p>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4">
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
        </div>

        {book.pages.length === 0 ? (
          <div className="text-center text-gray-400 mt-8">
            <p className="text-sm">まだページがありません</p>
            <p className="text-sm">上のボタンから写真を追加してください</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {book.pages.map((page) => (
              <div key={page.id} className="bg-white rounded-2xl shadow overflow-hidden">
                <button
                  onClick={() => setExpandedPage(expandedPage === page.id ? null : page.id)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700">ページ {page.pageNumber}</span>
                    {page.status === "processing" && (
                      <span className="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full animate-pulse">処理中</span>
                    )}
                    {page.status === "done" && (
                      <span className="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">完了</span>
                    )}
                    {page.status === "error" && (
                      <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">エラー</span>
                    )}
                  </div>
                  <span className="text-gray-300 text-sm">{expandedPage === page.id ? "▲" : "▼"}</span>
                </button>

                {expandedPage === page.id && (
                  <div className="px-4 pb-4">
                    {page.status === "processing" ? (
                      <p className="text-sm text-gray-400 text-center py-4">文字認識中...</p>
                    ) : page.status === "error" ? (
                      <p className="text-sm text-red-400 text-center py-4">エラーが発生しました（画像を再度試してください）</p>
                    ) : (
                      <>
                        <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans bg-gray-50 rounded-xl p-3 max-h-60 overflow-y-auto">
                          {page.text || "（テキストなし）"}
                        </pre>
                        <button
                          onClick={() => copyText(page.text)}
                          className="mt-2 w-full bg-gray-100 text-gray-600 py-2 rounded-xl text-sm"
                        >
                          コピー
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
