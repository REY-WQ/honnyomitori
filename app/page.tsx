"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { Book } from "@/lib/types";
import { getBooks, addBook, deleteBook, renameBook } from "@/lib/storage";

type ApiStatus = "checking" | "ok" | "error";

export default function Home() {
  const router = useRouter();
  const [books, setBooks] = useState<Book[]>([]);
  const [title, setTitle] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [apiError, setApiError] = useState("");

  async function reload() {
    const b = await getBooks();
    setBooks(b);
    setLoading(false);
  }

  async function checkApi() {
    setApiStatus("checking");
    try {
      const res = await fetch("/api/ocr");
      const data = await res.json();
      if (data.ok) {
        setApiStatus("ok");
        setApiError("");
      } else {
        setApiStatus("error");
        setApiError(data.error || "不明なエラー");
      }
    } catch {
      setApiStatus("error");
      setApiError("ネットワークエラー");
    }
  }

  useEffect(() => {
    reload();
    checkApi();
  }, []);

  async function createBook() {
    if (!title.trim()) return;
    const book: Book = {
      id: uuidv4(),
      title: title.trim(),
      createdAt: new Date().toISOString(),
      pages: [],
    };
    await addBook(book);
    setTitle("");
    setShowInput(false);
    reload();
  }

  async function removeBook(id: string) {
    if (deletingId !== id) {
      setDeletingId(id);
      return;
    }
    setDeletingId(null);
    await deleteBook(id);
    reload();
  }

  async function saveRename(id: string) {
    if (editTitle.trim()) {
      await renameBook(id, editTitle.trim());
      await reload();
    }
    setEditingId(null);
  }

  function startEdit(book: Book) {
    setEditingId(book.id);
    setEditTitle(book.title);
    setDeletingId(null);
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4 max-w-4xl mx-auto" onClick={() => { setDeletingId(null); }}>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">📚 本棚</h1>
        <button
          onClick={() => setShowInput(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-medium shadow"
        >
          + 新しい本
        </button>
      </div>

      {/* API状態バナー */}
      {apiStatus === "error" && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-3 mb-4 flex items-start gap-2">
          <span className="text-red-500 text-sm shrink-0">⚠️</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-700">OCR機能が使えません</p>
            <p className="text-xs text-red-500 mt-0.5 break-all">{apiError}</p>
            <p className="text-xs text-red-400 mt-1">Google Cloud ConsoleでCloud Vision APIキーを確認してください</p>
          </div>
          <button onClick={checkApi} className="text-xs text-red-400 underline shrink-0">再確認</button>
        </div>
      )}
      {apiStatus === "ok" && (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-2.5 mb-4 flex items-center gap-2">
          <span className="text-green-500 text-sm">✓</span>
          <p className="text-xs text-green-700 font-medium">OCR機能は正常に動作しています</p>
        </div>
      )}
      {apiStatus === "checking" && (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-2.5 mb-4 flex items-center gap-2">
          <span className="text-gray-400 text-xs animate-pulse">●</span>
          <p className="text-xs text-gray-400">OCR接続を確認中...</p>
        </div>
      )}

      {showInput && (
        <div className="bg-white rounded-2xl shadow p-4 mb-4">
          <p className="text-sm text-gray-500 mb-2">本のタイトルを入力</p>
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createBook()}
            placeholder="例：吾輩は猫である"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm mb-3 outline-none focus:border-blue-400"
          />
          <div className="flex gap-2">
            <button onClick={createBook} className="flex-1 bg-blue-600 text-white py-2 rounded-xl text-sm font-medium">作成</button>
            <button onClick={() => { setShowInput(false); setTitle(""); }} className="flex-1 bg-gray-100 text-gray-600 py-2 rounded-xl text-sm">キャンセル</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 mt-20">
          <p className="text-sm">読み込み中...</p>
        </div>
      ) : books.length === 0 ? (
        <div className="text-center text-gray-400 mt-20">
          <p className="text-4xl mb-3">📖</p>
          <p className="text-sm">まだ本がありません</p>
          <p className="text-sm">「新しい本」から追加してください</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {books.map((book) => {
            const done = book.pages.filter((p) => p.status === "done");
            const processing = book.pages.filter((p) => p.status === "processing").length;
            const errors = book.pages.filter((p) => p.status === "error").length;
            const totalChars = done.reduce((s, p) => s + p.text.length, 0);
            return (
              <div key={book.id} className="bg-white rounded-2xl shadow p-4" onClick={(e) => e.stopPropagation()}>
                {editingId === book.id ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveRename(book.id); if (e.key === "Escape") setEditingId(null); }}
                      className="flex-1 border border-blue-300 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-blue-500"
                    />
                    <button onClick={() => saveRename(book.id)} className="bg-blue-600 text-white px-3 py-1.5 rounded-xl text-sm">保存</button>
                    <button onClick={() => setEditingId(null)} className="bg-gray-100 text-gray-600 px-3 py-1.5 rounded-xl text-sm">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <button onClick={() => router.push(`/book/${book.id}`)} className="flex-1 text-left min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{book.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-1">
                        <span>{done.length} / {book.pages.length} ページ完了</span>
                        {totalChars > 0 && <span>・{totalChars.toLocaleString()}文字</span>}
                        {processing > 0 && <span className="text-blue-500">・処理中{processing}枚</span>}
                        {errors > 0 && <span className="text-red-400">・{errors}件エラー</span>}
                        <span>・{new Date(book.createdAt).toLocaleDateString("ja-JP")}</span>
                      </p>
                    </button>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      <button onClick={() => startEdit(book)} className="text-gray-300 hover:text-blue-400 text-sm">✏️</button>
                      {deletingId === book.id ? (
                        <button
                          onClick={() => removeBook(book.id)}
                          className="text-xs bg-red-500 text-white px-2 py-0.5 rounded-full"
                        >
                          確認
                        </button>
                      ) : (
                        <button onClick={() => removeBook(book.id)} className="text-gray-300 hover:text-red-400 text-lg">🗑️</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
