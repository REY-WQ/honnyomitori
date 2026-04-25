"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import { Book } from "@/lib/types";
import { getBooks, addBook, deleteBook, renameBook } from "@/lib/storage";

export default function Home() {
  const router = useRouter();
  const [books, setBooks] = useState<Book[]>([]);
  const [title, setTitle] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function reload() {
    const b = await getBooks();
    setBooks(b);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

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
    <main className="min-h-screen bg-gray-50 p-4 max-w-lg mx-auto" onClick={() => { setDeletingId(null); }}>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">📚 本棚</h1>
        <button
          onClick={() => setShowInput(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-medium shadow"
        >
          + 新しい本
        </button>
      </div>

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
        <div className="flex flex-col gap-3">
          {books.map((book) => {
            const done = book.pages.filter((p) => p.status === "done");
            const totalChars = done.reduce((s, p) => s + p.text.length, 0);
            return (
              <div key={book.id} className="bg-white rounded-2xl shadow p-4" onClick={(e) => e.stopPropagation()}>
                {editingId === book.id ? (
                  <div className="flex gap-2 mb-1">
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
                    <button onClick={() => router.push(`/book/${book.id}`)} className="flex-1 text-left">
                      <p className="font-semibold text-gray-800">{book.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {done.length} / {book.pages.length} ページ完了
                        {totalChars > 0 && <span className="ml-1">・{totalChars.toLocaleString()}文字</span>}
                        <span className="ml-1">・{new Date(book.createdAt).toLocaleDateString("ja-JP")}</span>
                      </p>
                    </button>
                    <div className="flex items-center gap-2 ml-2">
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
