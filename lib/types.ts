export interface Page {
  id: string;
  pageNumber: number;
  text: string;
  processedAt: string;
  status: "pending" | "processing" | "done" | "error";
}

export interface Book {
  id: string;
  title: string;
  createdAt: string;
  pages: Page[];
}
