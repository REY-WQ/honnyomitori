import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "本棚OCR",
    short_name: "本棚OCR",
    description: "本のページを撮影してテキスト化するアプリ",
    start_url: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#2563eb",
    orientation: "portrait",
  };
}
